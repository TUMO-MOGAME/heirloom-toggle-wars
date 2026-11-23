import "server-only";
/**
 * Scheduled payments ("living plans"): finds recurring rules whose next payment is due and executes them with
 * execute_scheduled, the agent's WDK wallet paying only the network fee. The program re-checks everything
 * (due time, caps, end date, estate status, fixed payee), so a wrong pick here just fails harmlessly.
 *
 * A payment that can't succeed must never stand in the way of one that can (plan §18.3 S1):
 *  1. the two scans keep only due rules of open estates that this agent serves;
 *  2. they are taken in a fair order (schedule-order.ts);
 *  3. just before a window of them is tried, its accounts are read together and what can't pay is passed over
 *     (vault, yearly cap, payee, beneficiary). That uses no attempt and no RPC call of its own;
 *  4. a failed attempt uses no place among the payments, only one of the attempts;
 *  5. attempts and time are bounded inside the route's maxDuration (60 s).
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { accountDiscriminator, getCoder, getIdl } from "../chain/idl";
import { big, bool, decodeRule, decodeEstate, enumOf, key, num, type Raw } from "../chain/decoders";
import { tokenAmount } from "../chain/balances";
import { TOKEN_PROGRAM_ID, ata, beneficiaryPda, payeePda, vaultAta, yearCapPda } from "../chain/pda";
import { getConnection } from "../chain/tx";
import { chainCtx } from "../chain/client";
import { executeScheduled } from "../chain/instructions";
import { agentAddress, agentSignAndSend } from "../agent/agent-wallet";
import type { Rule } from "../types";
import { chainConfig } from "../chain/config";
import { DeadlineError, withDeadline } from "./deadline";
import { scheduleOrder, type Random } from "./schedule-order";
import { assertProgram } from "./program";
import { agentRentLeft, spendAgentRent } from "../agent/budget";

export interface TickResult { rule: string; estate: string; ok: boolean; signature?: string; explorerUrl?: string; error?: string }

/** Pure: is this rule due for a scheduled payment at `now`? (mirrors the program's checks) */
export function isDue(rule: Rule, estateStatus: string, now: number): boolean {
  if (rule.recurringAmount <= 0n || !rule.fixedPayee || rule.nextDue === null) return false;
  if (rule.nextDue > now || now > rule.validUntil) return false;
  if (rule.spentTotal + rule.recurringAmount > rule.lifetimeCap) return false;
  // Spec #27: Unlocked, or Active if starts_now.
  return estateStatus === "Unlocked" || (rule.startsNow && estateStatus === "Active");
}

/** Below this the instalment is worth less than the rent and fee the agent would pay for it. */
export const MIN_SCHEDULED_BASE = 1_000_000n;

export const TICK = {
  /** Payments made in one tick. */
  paid: 10,
  paidPerEstate: 3,
  /** Transactions tried in one tick, whether or not they pay. */
  attempts: 40,
  attemptsPerEstate: 4,
  /** Rules whose accounts are read together: five accounts each, within getMultipleAccounts' 100. */
  window: 20,
  /** Nothing new starts after this. */
  startUntilMs: 40_000,
  attemptMs: 12_000,
  /** Everything has answered or been given up on by now (the route's maxDuration is 60 s). */
  endMs: 52_000,
} as const;

/** Pure: the due payments the agent will pay fees for: estates it serves, nothing trivial. */
export function servedPayments<T extends { estate: string; rule: Pick<Rule, "recurringAmount"> }>(
  due: T[], estates: Map<string, { agent: string; usdtMint: string }>, agent: string, mint: string,
): T[] {
  return due.filter((d) => {
    const e = estates.get(d.estate);
    return !!e && e.agent === agent && e.usdtMint === mint && d.rule.recurringAmount >= MIN_SCHEDULED_BASE;
  });
}

export type Blocked = "underfunded" | "yearly_cap" | "payee_removed" | "payee_account" | "beneficiary_removed";

type Account = AccountInfo<Buffer> | null;
export interface PaymentAccounts { vault: Account; yearCap: Account; payee: Account; payeeToken: Account; beneficiary: Account }
interface Payment { estate: string; rule: Rule }

const YEAR_SECS = 365 * 86_400;
const TOKEN_ACCOUNT_BYTES = 165;
const INITIALIZED = 1;

function accountsOf(d: Payment, programId: PublicKey, mint: PublicKey): PublicKey[] {
  const payee = d.rule.fixedPayee!;
  return [
    vaultAta(mint, d.estate), yearCapPda(programId, d.rule.address), payeePda(programId, d.estate, payee),
    ata(mint, payee), beneficiaryPda(programId, d.estate, d.rule.beneficiary),
  ];
}

/** Pure: why this payment can't succeed with what the chain holds, or null. */
export function whyUnpayable(d: Payment, a: PaymentAccounts, now: number, programId: PublicKey, mint: PublicKey): Blocked | null {
  const amount = d.rule.recurringAmount;
  const payee = d.rule.fixedPayee!;
  const usable = (info: Account, owner: string) =>
    !!info && info.owner.equals(TOKEN_PROGRAM_ID) && info.data.length === TOKEN_ACCOUNT_BYTES
    && mint.equals(new PublicKey(info.data.subarray(0, 32)))
    && new PublicKey(info.data.subarray(32, 64)).toBase58() === owner
    && info.data[108] === INITIALIZED;
  const ours = (info: Account) => !!info && info.owner.equals(programId) && info.data.length > 0;
  const decode = (type: string, info: Account) => getCoder().accounts.decode(type, info!.data) as Raw;

  if (!usable(a.vault, d.estate) || tokenAmount(a.vault!.data) < amount) return "underfunded";
  // Removed (the account is closed), or put back as a kind the rule doesn't allow.
  if (!ours(a.payee) || enumOf(decode("Payee", a.payee), "kind", [d.rule.allowedPayeeKind]) !== d.rule.allowedPayeeKind) return "payee_removed";
  if (!ours(a.beneficiary) || !bool(decode("Beneficiary", a.beneficiary), "active")) return "beneficiary_removed";
  // A payee without a token account gets one. One that exists must still be theirs (and the vault can't pay itself).
  if (payee === d.estate || (a.payeeToken?.data.length && !usable(a.payeeToken, payee))) return "payee_account";
  if (ours(a.yearCap)) {
    const cap = decode("YearCap", a.yearCap);
    const spent = now >= num(cap, "period_start") + YEAR_SECS ? 0n : big(cap, "period_spent");
    if (key(cap, "rule") !== d.rule.address || spent + amount > big(cap, "cap")) return "yearly_cap";
  }
  return null;
}

export interface TickOptions {
  /** Milliseconds; only for measuring this tick. */
  clock?: () => number;
  random?: Random;
}

/** The message of a failure, without an RPC URL (it can carry an API key). */
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/(https?|wss?):\/\/\S+/g, "[url]").slice(0, 300);

export async function runDueSchedules(
  now = Math.floor(Date.now() / 1000), { clock = Date.now, random = Math.random }: TickOptions = {},
): Promise<TickResult[]> {
  if (!getIdl().instructions.some((i) => i.name === "execute_scheduled")) return [];
  const started = clock();
  const left = () => started + TICK.endMs - clock();
  const agentKey = await agentAddress();
  if (!agentKey) return [];
  await assertProgram();
  const agent = new PublicKey(agentKey);
  const ctx = chainCtx();
  const programId = new PublicKey(getIdl().address);
  const conn = getConnection();
  const coder = getCoder();
  const scan = (type: string, more: { memcmp: { offset: number; bytes: string } }[] = []) => withDeadline(
    conn.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator(type)) } }, ...more],
    }),
    left(), `Reading ${type} accounts`,
  );

  const dueNow: Payment[] = [];
  for (const a of await scan("Rule")) {
    try {
      const raw = coder.accounts.decode("Rule", a.account.data) as Raw;
      const rule = decodeRule(a.pubkey.toBase58(), raw);
      if (rule.recurringAmount > 0n && rule.nextDue !== null && rule.nextDue <= now && now <= rule.validUntil) {
        dueNow.push({ estate: key(raw, "estate"), rule });
      }
    } catch { /* an account this build can't read: not ours to pay */ }
  }
  if (dueNow.length === 0) return [];

  // Estate = [disc 8][owner 32][agent 32][usdt_mint 32]: one scan for every estate this agent serves.
  const estates = new Map<string, { agent: string; usdtMint: string; status: string }>();
  const served = await scan("Estate", [
    { memcmp: { offset: 40, bytes: agentKey } },
    { memcmp: { offset: 72, bytes: ctx.usdtMint.toBase58() } },
  ]);
  for (const a of served) {
    try {
      const address = a.pubkey.toBase58();
      estates.set(address, decodeEstate(address, coder.accounts.decode("Estate", a.account.data) as Raw, 0n));
    } catch { /* as above */ }
  }

  const queue = scheduleOrder(
    servedPayments(dueNow, estates, agentKey, chainConfig.usdtMint).filter((d) => isDue(d.rule, estates.get(d.estate)!.status, now)),
    random,
  );

  const out: TickResult[] = [];
  const paid = new Map<string, number>();
  const tried = new Map<string, number>();
  let payments = 0;
  const estateFull = (estate: string) =>
    (paid.get(estate) ?? 0) >= TICK.paidPerEstate || (tried.get(estate) ?? 0) >= TICK.attemptsPerEstate;
  const tickFull = () => payments >= TICK.paid || out.length >= TICK.attempts || clock() - started >= TICK.startUntilMs;

  let next = 0;
  while (next < queue.length && !tickFull()) {
    const window: Payment[] = [];
    while (next < queue.length && window.length < TICK.window) {
      const d = queue[next++];
      if (!estateFull(d.estate)) window.push(d);
    }
    if (window.length === 0) break;

    let infos: Account[];
    try {
      infos = await withDeadline(
        conn.getMultipleAccountsInfo(window.flatMap((d) => accountsOf(d, programId, ctx.usdtMint)), "confirmed"),
        Math.min(TICK.attemptMs, left()), "Reading payment accounts",
      );
    } catch (e) {
      console.warn(`[scheduler] ${failure(e)}`);
      continue; // this window gets another turn next tick; the clock still bounds the loop
    }

    /** What this window has taken from each vault, or may have. */
    const taken = new Map<string, bigint>();
    for (const [i, d] of window.entries()) {
      if (tickFull()) break;
      if (estateFull(d.estate)) continue;
      const [vault, yearCap, payee, payeeToken, beneficiary] = infos.slice(i * 5, i * 5 + 5);
      try {
        if (whyUnpayable(d, { vault, yearCap, payee, payeeToken, beneficiary }, now, programId, ctx.usdtMint)) continue;
      } catch { continue; } // unreadable: can't be paid
      const afterThis = (taken.get(d.estate) ?? 0n) + d.rule.recurringAmount;
      if (afterThis > tokenAmount(vault!.data)) continue;
      // A payee with no USD₮ account gets one at the agent's cost: bounded and counted (M7). Over the bound it waits.
      const createsAccount = !payeeToken?.data.length;
      if (createsAccount && !agentRentLeft("schedule", d.estate, clock())) continue;

      tried.set(d.estate, (tried.get(d.estate) ?? 0) + 1);
      const result: TickResult = { rule: d.rule.address, estate: d.estate, ok: false };
      try {
        const ix = executeScheduled(ctx, {
          estate: new PublicKey(d.estate), payer: agent, rule: new PublicKey(d.rule.address),
          beneficiary: new PublicKey(d.rule.beneficiary), payeeWallet: new PublicKey(d.rule.fixedPayee!),
        });
        const tx = await withDeadline(agentSignAndSend([ix]), Math.min(TICK.attemptMs, left()), "Paying");
        Object.assign(result, tx, { ok: true });
        if (createsAccount) await spendAgentRent("schedule", d.estate, clock()).catch(() => undefined);
        payments++;
        paid.set(d.estate, (paid.get(d.estate) ?? 0) + 1);
        taken.set(d.estate, afterThis);
      } catch (e) {
        result.error = failure(e);
        // No answer is not a failure: it may have paid. The program's due date stops a second payment.
        if (e instanceof DeadlineError) taken.set(d.estate, afterThis);
      }
      out.push(result);
    }
  }
  return out;
}
