import "server-only";
/**
 * Starter funds for a new devnet wallet, so a person with nothing can create, fund and use a plan: a little SOL for
 * account rent and some test USD₮, both from the agent's wallet. Devnet only (plan §18.3 S2).
 *
 * The limits are read from the chain, so they hold across server instances and restarts:
 *  - once per wallet: no test-USD₮ account yet, and no grant of ours in its history. The grant creates that account
 *    non-idempotently, so two racing grants to one wallet can't both land;
 *  - an hourly and a daily pace, counted from grant marks only the agent can make (server/agent-ledger.ts). An
 *    hour's burst takes a quarter of the day, never all of it;
 *  - a pace per network address (plan §18.9 H2), so one address can't take a whole hour's or day's grants. It is kept
 *    on this instance and in the shared store, never on the chain (the memo holds nothing made from an address);
 *  - a reserve: the agent always keeps enough SOL for reviews and sponsored fees.
 * The shared store, when there is one, makes the pace atomic across instances as well.
 *
 * The amount is measured in starter/cost.test.ts from the accounts a newcomer's plan creates.
 * A wallet that already has SOL (from faucet.solana.com) gets only the test USD₮.
 */
import {
  ComputeBudgetProgram, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction, type Connection,
} from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import { HttpError } from "../api/http";
import { agentAddress, agentCoSign, hasAgentWallet } from "../agent/agent-wallet";
import { chainConfig } from "../chain/config";
import { tokenAmount } from "../chain/balances";
import { ata } from "../chain/pda";
import { base64ToBytes, bytesToBase64, confirmOrThrow, getConnection } from "../chain/tx";
import { explorerTx } from "../format";
import { withDeadline } from "../server/deadline";
import { DAY_SECS, HOUR_SECS, agentLedger, grantMemo, grantsIn, walletTag, type Grant } from "../server/agent-ledger";
import { claimSharedOnce, takeShared } from "../server/shared-store";
import { assertProgram } from "../server/program";

export const STARTER = {
  /** Rent for an estate, its people, rules, guard, seats, one asset and six practice wallets (cost.test.ts). */
  lamports: 80_000_000,
  /** What a grant costs the agent besides that: the wallet's USD₮ account, and the fee. */
  accountLamports: 1_500_000,
  usdt: 500_000_000n, // 500 test USD₮
  perHour: 12,
  perDay: 48,
  /** One network address (a person on mobile data, a room on one Wi-Fi). */
  perIpHour: 4,
  perIpDay: 8,
  reserveLamports: 300_000_000,
  /** From here the wallet has its setup SOL: it gets only the test USD₮. */
  hasSolLamports: 20_000_000,
  /** Requests waiting on one instance, and how long one may wait. */
  queue: 5,
  queueMs: 12_000,
  confirmMs: 18_000,
} as const;

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export const starterAvailable = () =>
  chainConfig.dataMode === "chain" && chainConfig.cluster === "devnet" && hasAgentWallet() && Boolean(chainConfig.usdtMint);

export type StarterRefusal = "already_funded" | "has_usdt_account" | "hourly_cap" | "daily_cap" | "rate_limited" | "empty";
export interface Refused { code: StarterRefusal; retryAfterSecs?: number }

export const starterLamports = (walletLamports: number): number => (walletLamports >= STARTER.hasSolLamports ? 0 : STARTER.lamports);

/** Pure: whether the pace allows another grant now; if not, when it will. */
export function starterPace(grantTimes: number[], now: number, max: { hour: number; day: number } = { hour: STARTER.perHour, day: STARTER.perDay }): Refused | null {
  const waitFor = (windowSecs: number, max: number) => {
    const recent = grantTimes.filter((t) => t > now - windowSecs).sort((a, b) => a - b);
    return recent.length < max ? 0 : Math.max(1, recent[recent.length - max] + windowSecs - now);
  };
  const day = waitFor(DAY_SECS, max.day);
  const hour = waitFor(HOUR_SECS, max.hour);
  if (day) return { code: "daily_cap", retryAfterSecs: Math.max(day, hour) };
  return hour ? { code: "hourly_cap", retryAfterSecs: hour } : null;
}

/** Pure: why this grant must be refused, or null. */
export function starterRefusal(s: {
  walletLamports: number; walletHasUsdtAccount: boolean; grantedBefore: boolean; grantTimes: number[]; now: number;
  agentLamports: number; agentUsdt: bigint;
}): Refused | null {
  if (s.grantedBefore) return { code: "already_funded" };
  // Granting into an account that exists would lose the guard against two grants racing (the grant creates it).
  if (s.walletHasUsdtAccount) return { code: "has_usdt_account" };
  const paced = starterPace(s.grantTimes, s.now);
  if (paced) return paced;
  const cost = starterLamports(s.walletLamports) + STARTER.accountLamports;
  return s.agentLamports - cost < STARTER.reserveLamports || s.agentUsdt < STARTER.usdt ? { code: "empty" } : null;
}

const FAUCET = "Free devnet SOL is at https://faucet.solana.com.";

function refuse({ code, retryAfterSecs }: Refused): HttpError {
  const inMinutes = `Try again in ${Math.ceil((retryAfterSecs ?? 0) / 60)} minutes.`;
  const message: Record<StarterRefusal, string> = {
    already_funded: `This wallet already had its test money. ${FAUCET}`,
    has_usdt_account: `This wallet already has a USD₮ account, so starter funds can't be sent to it. Use a new wallet. ${FAUCET}`,
    rate_limited: `This network has had its starter funds for now. ${inMinutes} ${FAUCET}`,
    hourly_cap: `This hour's starter funds are used up. ${inMinutes} ${FAUCET}`,
    daily_cap: `Today's starter funds are used up. ${inMinutes} ${FAUCET}`,
    empty: `The starter wallet is empty until it is restocked. ${FAUCET}`,
  };
  return new HttpError(code === "already_funded" || code === "has_usdt_account" ? 409 : 429, message[code], code, retryAfterSecs);
}

const busy = (retryAfterSecs: number) =>
  new HttpError(503, `The test network is busy. Try again in ${retryAfterSecs} seconds. ${FAUCET}`, "busy", retryAfterSecs);

/** Grants this instance sent that the chain may not list yet. */
let sent: Grant[] = [];
/** Grant times (unix seconds) by network address, on this instance. */
const byIp = new Map<string, number[]>();
let line: Promise<unknown> = Promise.resolve();
let waiting = 0;

/** One grant at a time on an instance, so two can't both take the last place. */
async function inLine<T>(job: () => Promise<T>): Promise<T> {
  if (waiting >= STARTER.queue) throw busy(20);
  waiting++;
  const joined = Date.now();
  const mine = line.then(() => {
    if (Date.now() - joined > STARTER.queueMs) throw busy(20);
    return job();
  });
  line = mine.catch(() => undefined);
  try {
    return await mine;
  } finally {
    waiting--;
  }
}

export interface Granted { signature: string; explorerUrl: string; sol: number; usdt: number }

/** `ip`: the caller's network address (api/http clientIp), paced by perIpHour and perIpDay. */
export async function grantStarter(wallet: string, conn: Connection = getConnection(), ip?: string): Promise<Granted> {
  if (!starterAvailable()) throw new HttpError(503, `Starter funds are only on the test network. ${FAUCET}`, "unavailable");
  const to = new PublicKey(wallet);
  if (!PublicKey.isOnCurve(to.toBytes())) throw new HttpError(400, "Starter funds go only to a person's wallet.", "bad_wallet");
  const from = new PublicKey((await agentAddress())!);
  if (from.equals(to)) throw new HttpError(400, "Starter funds go only to a person's wallet.", "bad_wallet");
  // Money for a plan this app would write wrongly is money wasted.
  await assertProgram();
  return inLine(async () => {
    try {
      return await grant(conn, from, to, ip);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.warn(`[starter] ${e instanceof Error ? e.name : "error"} while granting`);
      throw busy(30);
    }
  });
}

async function grant(conn: Connection, from: PublicKey, to: PublicKey, ip?: string): Promise<Granted> {
  const wallet = to.toBase58();
  const mint = new PublicKey(chainConfig.usdtMint);
  const [toAta, fromAta] = [ata(mint, to), ata(mint, from)];
  const reads = Promise.all([
    conn.getBalance(to, "confirmed"),
    conn.getAccountInfo(toAta, "confirmed"),
    conn.getBalance(from, "confirmed"),
    conn.getAccountInfo(fromAta, "confirmed"),
    conn.getSignaturesForAddress(to, { limit: 1000 }, "confirmed"),
    agentLedger(from, conn).history(),
  ]);
  const [walletLamports, account, agentLamports, agentAccount, theirs, history] = await withDeadline(reads, 16_000, "Reading the starter's limits");

  const now = Math.floor(Date.now() / 1000);
  sent = sent.filter((g) => g.at > now - DAY_SECS);
  const grants = new Map([...grantsIn(history.txs), ...sent].map((g) => [g.mac, g]));
  const tag = walletTag(wallet);
  const inWallet = grantsIn(theirs.map((t) => ({ memo: t.memo, failed: !!t.err })));
  const refused = starterRefusal({
    walletLamports,
    // Only the token program can give the account data: lamports sent to its address make no account.
    walletHasUsdtAccount: (account?.data.length ?? 0) > 0,
    grantedBefore: [...grants.values(), ...inWallet].some((g) => g.wallet === tag),
    grantTimes: [...grants.values()].map((g) => g.at),
    now,
    agentLamports,
    agentUsdt: tokenAmount(agentAccount?.data),
  });
  if (refused) throw refuse(refused);
  // A flooded history can't be counted: wait for the next read to page further back, never guess low.
  if (history.from > now - DAY_SECS) throw busy(60);

  const fromIp = ip === undefined ? null : (byIp.get(ip) ?? []).filter((t) => t > now - DAY_SECS);
  if (fromIp) {
    const paced = starterPace(fromIp, now, { hour: STARTER.perIpHour, day: STARTER.perIpDay });
    if (paced) throw refuse({ code: "rate_limited", retryAfterSecs: paced.retryAfterSecs });
  }

  if ((await claimSharedOnce(`starter:${wallet}`, 120)) === false) throw busy(120);
  const taken = await takeShared([
    { key: "starter:all", max: STARTER.perHour, windowSecs: HOUR_SECS },
    { key: "starter:all", max: STARTER.perDay, windowSecs: DAY_SECS },
    ...(ip === undefined ? [] : [
      { key: `starter:ip:${ip}`, max: STARTER.perIpHour, windowSecs: HOUR_SECS },
      { key: `starter:ip:${ip}`, max: STARTER.perIpDay, windowSecs: DAY_SECS },
    ]),
  ]);
  if (taken && !taken.ok) {
    throw refuse({ code: taken.retryAfterSecs > HOUR_SECS ? "daily_cap" : "hourly_cap", retryAfterSecs: taken.retryAfterSecs });
  }

  const lamports = starterLamports(walletLamports);
  const { memo, grant: mark } = grantMemo(now, lamports + STARTER.accountLamports, wallet);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), // the memo is checked byte by byte
    ...(lamports ? [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })] : []),
    createAssociatedTokenAccountInstruction(from, toAta, to, mint),
    createTransferCheckedInstruction(fromAta, mint, toAta, from, STARTER.usdt, 6),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo, "utf8") }),
  );
  const { wireBase64, signature } = await agentCoSign(bytesToBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));

  // Counted from before it is sent: if the answer is lost, it may still land.
  sent.push(mark);
  if (fromIp && ip !== undefined) {
    byIp.set(ip, [...fromIp, now]);
    if (byIp.size > 10_000) for (const [k, ts] of byIp) if (!ts.some((t) => t > now - DAY_SECS)) byIp.delete(k);
  }
  try {
    await conn.sendRawTransaction(base64ToBytes(wireBase64), { maxRetries: 3 });
  } catch (e) {
    if (e instanceof SendTransactionError) { // refused in preflight: never sent
      sent = sent.filter((g) => g !== mark);
      if (fromIp && ip !== undefined) byIp.set(ip, fromIp);
    }
    throw e;
  }
  await withDeadline(confirmOrThrow(signature), STARTER.confirmMs, "Confirming the grant").catch(() => { throw busy(60); });
  return { signature, explorerUrl: explorerTx(signature), sol: lamports / 1e9, usdt: Number(STARTER.usdt / 1_000_000n) };
}
