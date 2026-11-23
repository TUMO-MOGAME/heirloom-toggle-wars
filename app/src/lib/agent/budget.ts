import "server-only";
/**
 * Keeps the agent's SOL from being drained through requests that are each valid (plan §18.3 S3):
 *  1. a daily allowance per wallet and per estate, on this instance;
 *  2. the same allowance across instances, when the shared store is there;
 *  3. without it, a backstop read from the chain: what the agent lost in the last hour and day (server/agent-ledger.ts).
 *     If the chain can't be read (a 429) the last good reading stands for ten minutes; after that a handful of
 *     requests still go through, so a busy RPC doesn't switch the test site off, and then it waits.
 * The fee sponsor is held to all it spends with the agent's (chainBackstop); the agent's own reviews, listings and
 * sales only to its own spend (agentBackstop), so no amount of sponsored fees can switch them off (plan §18.9 H3).
 * The balance reserve (agent-wallet.ts) is the last line under all of them.
 */
import { PublicKey } from "@solana/web3.js";
import { HttpError } from "../api/http";
import type { AgentAction } from "../access/messages";
import { agentLedger } from "../server/agent-ledger";
import { takeShared } from "../server/shared-store";
import { getConnection } from "../chain/tx";
import { getIdl } from "../chain/idl";
import { agentAddress } from "./agent-wallet";

const DAY_MS = 86_400_000;

export const AGENT_DAILY: Record<Exclude<AgentAction, "starter" | "reason">, { wallet: number; estate: number }> = {
  review: { wallet: 20, estate: 40 },
  "list-asset": { wallet: 6, estate: 10 },
  "accept-offer": { wallet: 6, estate: 10 },
};

/**
 * The chain backstop. Lamports, for everything but starter grants: the sponsor's whole daily budget (0.3 SOL) can be
 * one judging hour, so the hour allows that plus 0.05 SOL of the agent's own signatures, the day that plus 0.1 SOL.
 */
export const AGENT_SPEND = {
  hour: 350_000_000,
  day: 400_000_000,
  /** A reading is used again for this long. */
  freshMs: 20_000,
  /** And, when the chain can't be read, for this long. */
  staleMs: 10 * 60_000,
  /** Requests let through on one instance with no usable reading, per `staleMs`. */
  blind: 10,
} as const;

/** The agent's own work, apart from what it pays as the fee sponsor (its share of AGENT_SPEND's margins). */
export const AGENT_OWN_SPEND = { hour: 50_000_000, day: 100_000_000 } as const;

const hits = new Map<string, number[]>();
type Reading = Awaited<ReturnType<ReturnType<typeof agentLedger>["spend"]>> & { at: number };
let reading: Reading | null = null;
/** Requests let through without a usable reading, the sponsor's and the agent's apart. */
const blind = { sponsor: [] as number[], agent: [] as number[] };

const acceptOfferDisc = () => getIdl().instructions.find((i) => i.name === "accept_offer")?.discriminator;

/** The ledger's reading, at most `freshMs` old; null when there is none usable. */
async function usableReading(now: number): Promise<Reading | null> {
  if (!reading || now - reading.at > AGENT_SPEND.freshMs) {
    try {
      const agent = await agentAddress();
      if (!agent) throw new Error("no agent wallet");
      reading = { at: now, ...(await agentLedger(new PublicKey(agent), getConnection(), acceptOfferDisc()).spend()) };
    } catch (e) {
      console.warn(`[agent-budget] could not read the chain backstop (${e instanceof Error ? e.name : "error"})`);
    }
  }
  return reading && now - reading.at <= AGENT_SPEND.staleMs ? reading : null;
}

function checkSpend(spent: { hour: number; day: number } | null, max: { hour: number; day: number }): void {
  if (spent && spent.day >= max.day) {
    throw new HttpError(429, "The agent reached its spending limit for today. Please try again in a few hours.", "agent_limit", 3 * 3_600);
  }
  if (spent && spent.hour >= max.hour) {
    throw new HttpError(429, "The agent reached its spending limit for this hour. Please try again in an hour.", "agent_limit", 3_600);
  }
}

function passBlind(who: keyof typeof blind, now: number): void {
  blind[who] = blind[who].filter((t) => now - t < AGENT_SPEND.staleMs);
  if (blind[who].length >= AGENT_SPEND.blind) throw new HttpError(503, "The network is busy. Please try again in a minute.", "busy", 60);
  blind[who].push(now);
}

const limitReached = (retryAfterSecs: number) =>
  new HttpError(429, "The agent reached today's limit for this. Please try again tomorrow.", "agent_limit", retryAfterSecs);

/**
 * The fee sponsor's backstop: everything the agent's wallet lost lately, sponsored fees and its own work together.
 * A reading counts only once every transaction in it is read (a top-up can't hide spend). Always await it.
 */
export async function chainBackstop(now: number): Promise<void> {
  const usable = await usableReading(now);
  checkSpend(usable, AGENT_SPEND);
  if (usable?.complete && usable.read) return;
  passBlind("sponsor", now);
}

/**
 * The agent's own backstop, for reviews, listings and sales: only what its own work lost. However much the sponsor
 * spent, or however many sponsored transactions are still to be read, this one isn't moved by it. Always await it.
 */
export async function agentBackstop(now: number): Promise<void> {
  const usable = await usableReading(now);
  checkSpend(usable?.own ?? null, AGENT_OWN_SPEND);
  if (usable?.complete) return;
  passBlind("agent", now);
}

/**
 * Rent the agent pays for accounts it creates (plan §18.9 M7): a scheduled payment to a payee with no USD₮ account
 * creates one (and a payee can close it after each payment, to be paid its rent again), and a sale creates the
 * buyer's title account and the recipient's USD₮ account. Counted on this instance and in the shared store.
 */
export const AGENT_RENT = {
  /** Scheduled payments that create a payee's account: in all, and for one estate, a day. */
  scheduleDay: 30,
  schedulePerEstate: 3,
  /** Sales settled by the agent, in all, a day (each estate has its own allowance in AGENT_DAILY as well). */
  settleDay: 20,
} as const;

const rentHits = new Map<string, number[]>();
type RentKind = "schedule" | "settle";

function rentChecks(kind: RentKind, estate: string, now: number) {
  const checks = kind === "schedule"
    ? [{ key: "rent:schedule", max: AGENT_RENT.scheduleDay }, { key: `rent:schedule:e:${estate}`, max: AGENT_RENT.schedulePerEstate }]
    : [{ key: "rent:settle", max: AGENT_RENT.settleDay }];
  return checks.map((c) => ({ ...c, at: (rentHits.get(c.key) ?? []).filter((t) => now - t < DAY_MS) }));
}

/** Whether this instance still allows this rent today. Records nothing (a payment that fails creates no account). */
export function agentRentLeft(kind: RentKind, estate: string, now = Date.now()): boolean {
  return rentChecks(kind, estate, now).every((c) => c.at.length < c.max);
}

/**
 * Counts this rent here and in the shared store; throws 429 agent_limit when there is none left today. When the shared
 * store says another instance used it up, this instance counts the day as full too. Always await it.
 */
export async function spendAgentRent(kind: RentKind, estate: string, now = Date.now()): Promise<void> {
  const recent = rentChecks(kind, estate, now);
  const full = recent.find((c) => c.at.length >= c.max);
  if (full) throw limitReached(Math.max(1, Math.ceil((full.at[full.at.length - full.max] + DAY_MS - now) / 1000)));
  for (const c of recent) rentHits.set(c.key, [...c.at, now]);
  if (rentHits.size > 50_000) for (const [k, ts] of rentHits) if (!ts.some((t) => now - t < DAY_MS)) rentHits.delete(k);
  const taken = await takeShared(recent.map((c) => ({ key: `agent:${c.key}`, max: c.max, windowSecs: DAY_MS / 1000 }))).catch(() => null);
  if (taken && !taken.ok) {
    for (const c of recent) rentHits.set(c.key, Array<number>(c.max).fill(now));
    throw limitReached(taken.retryAfterSecs);
  }
}

/** Tests only. */
export function forgetAgentRent(): void { rentHits.clear(); }

/** Throws when the agent should not sign this. Always await it. */
export async function spendAgentAllowance(action: keyof typeof AGENT_DAILY, wallet: string, estate: string, now = Date.now()): Promise<void> {
  const limit = AGENT_DAILY[action];
  const checks = [
    { key: `${action}:w:${wallet}`, max: limit.wallet },
    { key: `${action}:e:${estate}`, max: limit.estate },
  ].map((c) => ({ ...c, recent: (hits.get(c.key) ?? []).filter((t) => now - t < DAY_MS) }));
  const full = checks.filter((c) => c.recent.length >= c.max);
  if (full.length) {
    const free = Math.max(...full.map((c) => c.recent[c.recent.length - c.max] + DAY_MS));
    throw limitReached(Math.max(1, Math.ceil((free - now) / 1000)));
  }
  // Expired entries go; nobody else's allowance is ever reset to make room.
  if (hits.size > 50_000) for (const [k, ts] of hits) if (!ts.some((t) => now - t < DAY_MS)) hits.delete(k);
  // Counted before any await, so requests arriving together can't all pass; given back on a refusal.
  for (const c of checks) hits.set(c.key, [...c.recent, now]);
  try {
    const taken = await takeShared(checks.map((c) => ({ key: `agent:${c.key}`, max: c.max, windowSecs: DAY_MS / 1000 })));
    if (!taken) await agentBackstop(now);
    else if (!taken.ok) throw limitReached(taken.retryAfterSecs);
  } catch (e) {
    for (const c of checks) {
      const list = hits.get(c.key) ?? [];
      const at = list.lastIndexOf(now);
      if (at >= 0) hits.set(c.key, list.toSpliced(at, 1));
    }
    throw e;
  }
}
