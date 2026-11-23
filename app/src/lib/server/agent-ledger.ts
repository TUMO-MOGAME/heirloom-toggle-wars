import "server-only";
/**
 * What the chain says the agent's wallet did lately (plan §18.3 S2, S3), so limits hold without a shared store.
 *
 * Anyone can mention the agent's address in a transaction, or write any memo, for 5,000 lamports. So:
 *  - a starter grant counts only with a memo carrying an HMAC under a key derived from the agent's seed, and once
 *    per HMAC, so a copied memo adds nothing. The memo holds a time, a cost and a short hash of the recipient's
 *    wallet (which the transfer itself shows), never an IP address or anything made from one;
 *  - spend is what the agent's own balance lost in each of its transactions (read once each, from the transaction's
 *    balances), so a top-up never hides it (plan §18.9 M1): a deposit is a gain, and gains are not netted against
 *    spend. Nobody else's transaction can make the agent lose SOL.
 *  - its own spend is told apart from the fee sponsor's: a sponsored transaction always has a second signer, the agent's
 *    own signatures (reviews, listings, scheduled payments) have none, except a co-signed sale (accept_offer). So the
 *    sponsor's spending can never stop the agent's own work (plan §18.9 H3).
 * A flood of mentions can only make the history longer: it is paged, kept, and continued on the next read.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import type { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { withDeadline } from "./deadline";

export const HOUR_SECS = 3_600;
export const DAY_SECS = 86_400;
/** getSignaturesForAddress' most per call. */
export const PAGE = 1_000;
/** Calls per read. */
export const MAX_PAGES = 10;

const READ_MS = 8_000;
/** All the pages of one read. A read given up on still finishes, for the next caller. */
const HISTORY_MS = 15_000;
/** A confirmed transaction can appear a little late: this much of what is held is read again. */
const SETTLE_SECS = 90;
const KEEP_SECS = DAY_SECS + HOUR_SECS;

export interface LedgerTx { signature: string; at: number; memo: string | null; failed: boolean }
/** `txs` newest first; complete from `from` (unix seconds) until `readAt`. */
export interface History { txs: LedgerTx[]; from: number; readAt: number }
export interface Grant { at: number; lamports: number; wallet: string; mac: string }

const MEMO = "heirloom-starter";
const MEMO_PATTERN = /heirloom-starter:(\d{1,12}):(\d{1,12}):([0-9a-f]{16}):([0-9a-f]{32})/g;

/** A key of our own from the agent's seed: no new secret to configure, and it can't sign anything. */
function grantKey(): Buffer | null {
  const seed = process.env.AGENT_SEED_PHRASE?.trim().split(/\s+/).join(" ");
  return seed ? createHmac("sha256", seed).update("heirloom starter grant marks v1").digest() : null;
}

export const walletTag = (wallet: string) => createHash("sha256").update(wallet, "utf8").digest("hex").slice(0, 16);
const macOf = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("hex").slice(0, 32);

/** The memo of a grant the agent makes, and the grant it records. */
export function grantMemo(at: number, lamports: number, wallet: string): { memo: string; grant: Grant } {
  const key = grantKey();
  if (!key) throw new Error("The agent wallet is not configured.");
  const tag = walletTag(wallet);
  const body = `${MEMO}:${at}:${lamports}:${tag}`;
  const mac = macOf(key, body);
  return { memo: `${body}:${mac}`, grant: { at, lamports, wallet: tag, mac } };
}

/** The real grants among these transactions, newest first, each once. */
export function grantsIn(txs: Pick<LedgerTx, "memo" | "failed">[]): Grant[] {
  const key = grantKey();
  if (!key) return [];
  const out = new Map<string, Grant>();
  for (const t of txs) {
    if (t.failed || !t.memo) continue;
    for (const [, at, lamports, wallet, mac] of t.memo.matchAll(MEMO_PATTERN)) {
      const expected = macOf(key, `${MEMO}:${at}:${lamports}:${wallet}`);
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) {
        out.set(mac, { at: Number(at), lamports: Number(lamports), wallet, mac });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

const unixNow = () => Math.floor(Date.now() / 1000);

/** What one transaction did to the agent: lamports lost (0 for a gain), and whether it was the agent's own work. */
export interface TxCost { lost: number; own: boolean }

/**
 * Pure. The agent's own work is any transaction it signed alone, or a co-signed sale; a sponsored one (a user signed
 * too) is the sponsor's. `acceptOffer`: the 8-byte discriminator of accept_offer, when the IDL has it.
 */
export function costOf(tx: ParsedTransactionWithMeta, agent: PublicKey, acceptOffer?: readonly number[]): TxCost | null {
  const keys = tx.transaction.message.accountKeys;
  const at = keys.findIndex((k) => k.pubkey.equals(agent));
  const pre = at >= 0 ? tx.meta?.preBalances[at] : undefined;
  const post = at >= 0 ? tx.meta?.postBalances[at] : undefined;
  if (pre === undefined || post === undefined) return null;
  const signers = keys.filter((k) => k.signer).length;
  const sale = !!acceptOffer && tx.transaction.message.instructions.some((ix) => {
    const data = "data" in ix ? bs58.decode(ix.data) : null;
    return !!data && acceptOffer.every((b, i) => data[i] === b);
  });
  return { lost: Math.max(0, pre - post), own: signers <= 1 || sale };
}

/** Transactions read per spend() call (the rest are read on the next ones), and two at a time. */
const READS_PER_CALL = 60;
const READ_PAIR = 2;
/** How long a spend() waits for transactions it hasn't read yet; they keep loading in the background. */
const DETAIL_MS = 4_000;

export function createLedger(address: PublicKey, conn: Connection, clock: () => number = unixNow, acceptOffer?: readonly number[]) {
  let held: History | null = null;
  let reading: Promise<History> | null = null;
  /** What each transaction cost the agent never changes, so it is read once. */
  const costs = new Map<string, TxCost>();
  let filling: Promise<void> | null = null;

  async function page(opts: { before?: string; until?: string }): Promise<LedgerTx[]> {
    const rows = await withDeadline(
      conn.getSignaturesForAddress(address, { limit: PAGE, ...opts }, "confirmed"), READ_MS, "Reading the agent's history",
    );
    return rows.map((r) => ({ signature: r.signature, at: r.blockTime ?? clock(), memo: r.memo, failed: !!r.err }));
  }

  async function read(): Promise<History> {
    const now = clock();
    const since = now - DAY_SECS;
    let pages = MAX_PAGES;
    let txs: LedgerTx[] = [];
    let from = Infinity;

    // What is new since the last read.
    if (held?.txs.length) {
      const anchor = held.txs.find((t) => t.at <= now - SETTLE_SECS);
      const fresh: LedgerTx[] = [];
      let cursor: string | undefined;
      let joined = false;
      while (pages > 0 && !joined) {
        pages--;
        const got = await page({ before: cursor, until: anchor?.signature });
        fresh.push(...got);
        cursor = got.at(-1)?.signature;
        // Either it reached what is held, or it went past the day and what is held no longer matters.
        joined = got.length < PAGE || got[got.length - 1].at < since;
      }
      if (joined) {
        const known = new Set(fresh.map((t) => t.signature));
        txs = [...fresh, ...held.txs.filter((t) => !known.has(t.signature))];
        from = held.from;
        if (fresh.length >= PAGE && fresh[fresh.length - 1].at < since) from = Math.min(from, since);
      } else {
        // Too much is new to join up: keep the newest part, and carry on back from there.
        txs = fresh;
        from = fresh[fresh.length - 1].at;
      }
    }

    // Further back, until the day is covered.
    while (pages > 0 && from > since) {
      pages--;
      const got = await page({ before: txs.at(-1)?.signature });
      txs.push(...got);
      from = got.length < PAGE ? 0 : got[got.length - 1].at;
    }

    const keep = now - KEEP_SECS;
    held = { txs: txs.filter((t, i) => i === 0 || t.at >= keep), from: Math.max(from, keep), readAt: now };
    return held;
  }

  /** The agent's transactions over the last day. */
  function history(): Promise<History> {
    reading ??= read().finally(() => { reading = null; });
    return withDeadline(reading, HISTORY_MS, "Reading the agent's history");
  }

  /** Reads, newest first, what the not yet read transactions cost; one run at a time, it carries on in the background. */
  function fill(txs: LedgerTx[]): Promise<void> {
    if (filling) return filling;
    const todo = txs.filter((t) => !costs.has(t.signature)).slice(0, READS_PER_CALL);
    filling = (async () => {
      for (let i = 0; i < todo.length; i += READ_PAIR) {
        await Promise.all(todo.slice(i, i + READ_PAIR).map(async (t) => {
          const tx = await withDeadline(
            conn.getParsedTransaction(t.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), READ_MS, "Reading an agent transaction",
          ).catch(() => null);
          const cost = tx ? costOf(tx, address, acceptOffer) : null;
          if (cost) costs.set(t.signature, cost);
        }));
      }
    })().finally(() => { filling = null; });
    return filling;
  }

  /**
   * SOL the agent lost in the last hour and day, apart from starter grants (those have their own pacing): in all, and
   * in its own work alone (`own`, without the fee sponsor's). `complete` is false when the history didn't reach back a
   * day, `read` false while some of its transactions are not read yet: then the numbers are lower bounds.
   */
  async function spend(): Promise<{ hour: number; day: number; own: { hour: number; day: number }; complete: boolean; read: boolean }> {
    const h = await history();
    const inDay = h.txs.filter((t) => t.at >= h.readAt - DAY_SECS); // failed ones cost their fee too
    await withDeadline(fill(inDay), DETAIL_MS, "Reading the agent's transactions").catch(() => undefined);
    if (costs.size > 5_000) { const keep = new Set(h.txs.map((t) => t.signature)); for (const k of costs.keys()) if (!keep.has(k)) costs.delete(k); }
    // A grant is paced by the starter itself: what its transaction lost, up to the grant, is not counted here.
    const granted = (t: LedgerTx) => grantsIn([t]).reduce((n, g) => n + g.lamports, 0);
    const sum = (since: number, own: boolean) => inDay.filter((t) => t.at >= since).reduce((n, t) => {
      const c = costs.get(t.signature);
      return n + (c && (!own || c.own) ? Math.max(0, c.lost - granted(t)) : 0);
    }, 0);
    const [hourAgo, dayAgo] = [h.readAt - HOUR_SECS, h.readAt - DAY_SECS];
    return {
      hour: sum(hourAgo, false), day: sum(dayAgo, false), own: { hour: sum(hourAgo, true), day: sum(dayAgo, true) },
      complete: h.from <= dayAgo, read: inDay.every((t) => costs.has(t.signature)),
    };
  }

  return { history, spend };
}

export type AgentLedger = ReturnType<typeof createLedger>;

let instance: { address: string; ledger: AgentLedger } | null = null;

/** The one ledger of this server instance. */
export function agentLedger(address: PublicKey, conn: Connection, acceptOffer?: readonly number[]): AgentLedger {
  if (instance?.address !== address.toBase58()) instance = { address: address.toBase58(), ledger: createLedger(address, conn, unixNow, acceptOffer) };
  return instance.ledger;
}
