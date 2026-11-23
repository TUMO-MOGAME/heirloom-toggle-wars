/**
 * Read side: fetch and decode every account of one estate, plus the activity feed from program events.
 * Uses getProgramAccounts with a discriminator + parent-key memcmp (the parent pubkey is the first field
 * after the 8-byte discriminator for Beneficiary/Payee/Rule/Claim/Asset (estate) and Offer/Hardship (asset)).
 */
import { EventParser } from "@anchor-lang/core";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { ActivityItem, Base58 } from "../types";
import { accountDiscriminator, accountName, getCoder, getIdl } from "./idl";
import {
  hex, key, ruleCount, decodeAgentVotes, decodeAsset, decodeBeneficiary, decodeClaim, decodeEstate, decodeHardship, decodeOffer, decodePayee, decodeRule,
  withClaimState, type OffChainNames, type Raw,
} from "./decoders";
import type { AgentVoteInfo } from "../continuity/types";
import { estatePda, vaultAta } from "./pda";
import { getConnection } from "./tx";
import { describeEvent, paymentFromEvent, saleFromEvent } from "./events";

export interface RawSnapshot {
  estate: ReturnType<typeof decodeEstate>;
  ruleCount: number;
  beneficiaries: ReturnType<typeof decodeBeneficiary>[];
  payees: ReturnType<typeof decodePayee>[];
  rules: ReturnType<typeof decodeRule>[];
  claims: ReturnType<typeof decodeClaim>[];
  assets: ReturnType<typeof decodeAsset>[];
  offers: ReturnType<typeof decodeOffer>[];
  hardships: ReturnType<typeof decodeHardship>[];
  agentVotes: AgentVoteInfo[];
  /** claim / hardship address → agent_report_hash (hex), for joining the off-chain AgentReport. */
  reportHashes: Record<string, string>;
}

const programId = () => new PublicKey(getIdl().address);

/** An account of this program from a scan, as raw IDL fields. */
export const decodeScanned = (type: string, account: ProgramAccount): Raw => decode(type, account.data);

function decode(name: string, data: Uint8Array): Raw {
  // Anchor's coder takes a Node-style Buffer; web3.js already gives us one.
  return getCoder().accounts.decode(accountName(name), data as Parameters<ReturnType<typeof getCoder>["accounts"]["decode"]>[1]) as Raw;
}

/**
 * One getProgramAccounts scan of the whole program, shared by every read for a few seconds.
 * The public devnet RPC throttles getProgramAccounts per method (HTTP 429 after a handful of calls), and one
 * estate load used to need 7+ filtered scans, so the dashboard could never finish loading. A single unfiltered
 * scan is cheap at hackathon scale; a production deployment would use an indexer or a paid RPC with filters.
 */
export interface ProgramAccount { pubkey: PublicKey; data: Uint8Array }
let scan: { at: number; accounts: Promise<ProgramAccount[]> } | null = null;
export function programAccounts(conn = getConnection(), maxAgeMs = 8_000): Promise<ProgramAccount[]> {
  if (scan && Date.now() - scan.at < maxAgeMs) return scan.accounts;
  const accounts = conn.getProgramAccounts(programId(), { commitment: "confirmed" })
    .then((res) => res.map((a) => ({ pubkey: a.pubkey, data: a.account.data as Uint8Array })));
  const entry = { at: Date.now(), accounts };
  scan = entry;
  accounts.catch(() => { if (scan === entry) scan = null; });
  return accounts;
}
/** Forget the shared scan (call after a write so the next read sees it). */
export function invalidateProgramAccounts(): void { scan = null; }

const startsWith = (data: Uint8Array, prefix: Uint8Array, at = 0) => prefix.every((b, i) => data[at + i] === b);

/**
 * An account of `type` written by this program, as raw IDL fields, or null. Anyone can create an account with the
 * right discriminator under another program (or send lamports to a PDA), so the owner is checked before anything is
 * decoded or trusted (plan §18.9 H4). A getProgramAccounts scan needs no check: the RPC returns only this program's.
 */
export function ownAccount(type: string, info: { owner: PublicKey; data: Uint8Array } | null): Raw | null {
  if (!info || !info.owner.equals(programId()) || !startsWith(info.data, accountDiscriminator(type))) return null;
  return decode(type, info.data);
}

/** Accounts of `type` whose first field (after the 8-byte discriminator) is `parent`, optionally another key at `offset`. */
export async function scanAccounts(type: string, match: { offset: number; key: PublicKey }[], conn = getConnection()): Promise<ProgramAccount[]> {
  const disc = accountDiscriminator(type);
  return (await programAccounts(conn)).filter((a) => startsWith(a.data, disc) && match.every((m) => startsWith(a.data, m.key.toBytes(), m.offset)));
}

async function fetchChildren(conn: Connection, type: string, parent: PublicKey): Promise<{ address: string; raw: Raw }[]> {
  const res = await scanAccounts(type, [{ offset: 8, key: parent }], conn);
  return res.map((a) => ({ address: a.pubkey.toBase58(), raw: decode(type, a.data) }));
}

export async function fetchEstateRaw(estate: Base58, names: OffChainNames = {}, conn = getConnection()): Promise<RawSnapshot> {
  const estateKey = new PublicKey(estate);
  const raw = ownAccount("Estate", await conn.getAccountInfo(estateKey, "confirmed"));
  if (!raw) throw new Error(`No Heirloom estate at ${estate} on this cluster.`);
  const mint = new PublicKey(key(raw, "usdt_mint"));
  const vault = vaultAta(mint, estateKey);
  const vaultBal = await conn.getTokenAccountBalance(vault, "confirmed").then((b) => BigInt(b.value.amount)).catch(() => 0n);
  const estateObj = decodeEstate(estate, raw, vaultBal, names);

  const [bens, payees, rules, claims, assets, votes, stamps] = await Promise.all([
    fetchChildren(conn, "Beneficiary", estateKey),
    fetchChildren(conn, "Payee", estateKey),
    fetchChildren(conn, "Rule", estateKey),
    fetchChildren(conn, "Claim", estateKey),
    fetchChildren(conn, "Asset", estateKey),
    fetchChildren(conn, "AgentVote", estateKey),
    // An ApprovalStamp names its claim, not the estate.
    scanAccounts("ApprovalStamp", [], conn),
  ]);
  const ruleObjs = rules.map((r) => decodeRule(r.address, r.raw)).sort((a, b) => a.id - b.id);
  const stampData = new Map(stamps.map((s) => [new PublicKey(s.data.subarray(8, 40)).toBase58(), s.data]));
  const claimObjs = claims.map((c) => {
    const claim = decodeClaim(c.address, c.raw);
    const stamp = stampData.get(c.address);
    return withClaimState(claim, {
      estate: estateObj, rule: ruleObjs.find((r) => r.address === claim.rule),
      ...(stamp ? { stamp: decode("ApprovalStamp", stamp) } : {}),
    });
  });
  // A program scan returns accounts in no fixed order: list assets in the order their titles were recorded
  // (registration order), so the first asset (the car) stays first on every load; untitled ones go last.
  const titleOrder = Object.keys(names.assetTitles ?? {});
  const rank = (nft: string) => { const i = titleOrder.indexOf(nft); return i < 0 ? titleOrder.length : i; };
  const assetObjs = assets
    .map((a) => ({ a, nft: key(a.raw, "nft_mint") }))
    .sort((x, y) => rank(x.nft) - rank(y.nft) || x.a.address.localeCompare(y.a.address))
    .map(({ a, nft }) => decodeAsset(a.address, a.raw, names.assetTitles?.[nft]));
  const perAsset = await Promise.all(assetObjs.map(async (a) => {
    const k = new PublicKey(a.address);
    const [o, h] = await Promise.all([fetchChildren(conn, "Offer", k), fetchChildren(conn, "Hardship", k)]);
    return {
      offers: o.map((x) => { const d = decodeOffer(x.address, x.raw); return { ...d, buyerName: names.buyerNames?.[d.buyer] }; }),
      hardships: h.map((x) => decodeHardship(x.address, x.raw)),
      hardshipReports: h.map((x) => [x.address, hex(x.raw, "agent_report_hash")] as const),
    };
  }));

  return {
    estate: estateObj,
    ruleCount: ruleCount(raw),
    beneficiaries: bens.map((b) => decodeBeneficiary(b.address, b.raw)),
    payees: payees.map((p) => decodePayee(p.address, p.raw)),
    rules: ruleObjs,
    claims: claimObjs.sort((a, b) => b.createdAt - a.createdAt),
    agentVotes: decodeAgentVotes(votes.map((v) => v.raw), estateObj),
    assets: assetObjs,
    offers: perAsset.flatMap((x) => x.offers).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)),
    hardships: perAsset.flatMap((x) => x.hardships),
    reportHashes: Object.fromEntries([
      ...claims.map((c) => [c.address, hex(c.raw, "agent_report_hash")] as const),
      ...perAsset.flatMap((x) => x.hardshipReports),
    ].filter(([, h]) => h !== "0".repeat(64))),
  };
}

/** Does `owner` have an estate? Returns its address or null. */
export async function findEstateOf(owner: Base58, conn = getConnection()): Promise<Base58 | null> {
  const pda = estatePda(programId(), owner);
  return ownAccount("Estate", await conn.getAccountInfo(pda, "confirmed")) ? pda.toBase58() : null;
}

// Confirmed transactions never change, so each is fetched once and remembered.
const txMemo = new Map<string, NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>>();
const filling = new Map<string, Promise<void>>();
/** Transactions being fetched right now, so the feed and the Trust Tree's history never ask for the same one twice. */
const inflight = new Map<string, Promise<void>>();

function fetchTx(sig: string, conn: Connection): Promise<void> {
  if (txMemo.has(sig)) return Promise.resolve();
  let p = inflight.get(sig);
  if (!p) {
    p = conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .then((tx) => { if (tx) txMemo.set(sig, tx); }, () => undefined)
      .finally(() => inflight.delete(sig));
    inflight.set(sig, p);
  }
  return p;
}

/**
 * Fetches the transactions not yet remembered, newest first, two at a time. Not one big batch: public devnet answers
 * a 40-call batch with per-item "Too many requests" errors, which used to empty the whole feed. Single calls retry on
 * 429 (tx.ts); one that still fails is tried again on the next refresh.
 */
function fill(key: string, signatures: string[], conn: Connection): Promise<void> {
  const running = filling.get(key);
  if (running) return running;
  const job = (async () => {
    const missing = signatures.filter((s) => !txMemo.has(s));
    for (let i = 0; i < missing.length; i += 2) await Promise.all(missing.slice(i, i + 2).map((sig) => fetchTx(sig, conn)));
  })().finally(() => filling.delete(key));
  filling.set(key, job);
  return job;
}

/** One decoded program event with its transaction. */
export interface ChainEvent { name: string; data: Raw; ts: number; signature: string }

/**
 * Recent program events that touched `address` (newest first), raw. Waits at most `budgetMs` for transactions not yet
 * remembered, so a busy RPC never holds up the page; the rest keep loading and appear on the next refresh.
 */
export async function fetchEvents(address: Base58, limit = 40, conn = getConnection(), budgetMs = 5_000): Promise<ChainEvent[]> {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit }, "confirmed");
  const ok = sigs.filter((s) => !s.err);
  if (ok.length === 0) return [];
  await Promise.race([fill(address, ok.map((s) => s.signature), conn), new Promise((r) => setTimeout(r, budgetMs))]);
  const parser = new EventParser(programId(), getCoder());
  const out: ChainEvent[] = [];
  ok.forEach((s) => {
    const tx = txMemo.get(s.signature);
    const logs = tx?.meta?.logMessages;
    if (!logs) return;
    const ts = tx.blockTime ?? s.blockTime ?? 0;
    try {
      for (const ev of parser.parseLogs(logs)) out.push({ name: ev.name, data: ev.data as Raw, ts, signature: s.signature });
    } catch {
      // A log we cannot decode (e.g. older IDL) is skipped, not fatal for the feed.
    }
  });
  return out.sort((a, b) => b.ts - a.ts);
}

/** The slice of a Connection that history reads use (tests pass a fake). */
export type HistoryConn = Pick<Connection, "getSignaturesForAddress" | "getTransaction">;

export interface HistoryOptions {
  /** Signatures per page (the RPC allows up to 1000). */
  pageSize?: number;
  /** Most pages to read. */
  maxPages?: number;
  /** Total time budget for signatures and transactions, in ms. */
  budgetMs?: number;
  now?: () => number;
}

/**
 * Every signature that touched `address`, newest first, paging back with `before` until the start of the history or the
 * time budget. `complete` is false when the budget (or `maxPages`) cut it short.
 */
export async function historySignatures(address: Base58, conn: HistoryConn, opts: HistoryOptions = {}): Promise<{ signatures: { signature: string; blockTime?: number | null }[]; complete: boolean }> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.budgetMs ?? 8_000);
  const out: { signature: string; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (now() >= deadline) return { signatures: out, complete: false };
    const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit: pageSize, ...(before ? { before } : {}) }, "confirmed");
    for (const s of sigs) if (!s.err) out.push({ signature: s.signature, blockTime: s.blockTime });
    if (sigs.length < pageSize) return { signatures: out, complete: true };
    before = sigs[sigs.length - 1].signature;
  }
  return { signatures: out, complete: false };
}

/**
 * The estate's full event history (newest first) for the Trust Tree: all signatures (paged beyond the feed's 40), then
 * each transaction once (remembered with the feed's, two at a time, quiet 429 retries in tx.ts), all within one time
 * budget. `partial` is true when older history could not be loaded in time; what was missing keeps loading in the
 * background and appears on the next read.
 */
export async function fetchHistory(address: Base58, conn: HistoryConn = getConnection(), opts: HistoryOptions = {}): Promise<{ events: ChainEvent[]; partial: boolean }> {
  const now = opts.now ?? (() => Date.now());
  const start = now();
  const budget = opts.budgetMs ?? 8_000;
  const { signatures, complete } = await historySignatures(address, conn, { ...opts, now, budgetMs: budget });
  const left = Math.max(0, budget - (now() - start));
  if (signatures.length) await Promise.race([fill(`history:${address}`, signatures.map((s) => s.signature), conn as Connection), new Promise((r) => setTimeout(r, left))]);
  const parser = new EventParser(programId(), getCoder());
  const out: ChainEvent[] = [];
  let missing = 0;
  for (const s of signatures) {
    const tx = txMemo.get(s.signature);
    const logs = tx?.meta?.logMessages;
    if (!tx) { missing++; continue; }
    if (!logs) continue;
    const ts = tx.blockTime ?? s.blockTime ?? 0;
    try {
      for (const ev of parser.parseLogs(logs)) out.push({ name: ev.name, data: ev.data as Raw, ts, signature: s.signature });
    } catch { /* an undecodable log (older IDL) is skipped */ }
  }
  return { events: out.sort((a, b) => b.ts - a.ts), partial: !complete || missing > 0 };
}

/** Plain-language activity lines from the estate's recent events (newest first). */
export function activityFrom(events: ChainEvent[]): ActivityItem[] {
  return events.map((ev) => {
    const d = describeEvent(ev.name, ev.data);
    let reportHash: string | undefined;
    try { reportHash = (d.kind.endsWith("Reviewed") || d.kind === "ReviewReferred") ? hex(ev.data, "report_hash") : undefined; } catch { /* no hash on this event */ }
    const sale = saleFromEvent(ev.name, ev.data);
    const payment = paymentFromEvent(ev.name, ev.data);
    return { ts: ev.ts, kind: d.kind, text: d.text, amount: d.amount, txSignature: ev.signature, ...(d.parties ? { parties: d.parties } : {}), ...(reportHash ? { reportHash } : {}), ...(sale ? { sale } : {}), ...(payment ? { payment } : {}) };
  });
}

export async function fetchActivity(estate: Base58, limit = 40, conn = getConnection(), budgetMs = 5_000): Promise<ActivityItem[]> {
  return activityFrom(await fetchEvents(estate, limit, conn, budgetMs));
}

/** Fetch and decode a single account of this program (raw IDL field names). Null if there is none of that type. */
export async function fetchAccountRaw(type: string, address: Base58, conn = getConnection()): Promise<Raw | null> {
  return ownAccount(type, await conn.getAccountInfo(new PublicKey(address), "confirmed"));
}

/**
 * The report hash of the review that the report standing now got. `events` newest first. A report can be replaced, so
 * an older review never speaks for a newer report: the search ends at the report's own event.
 */
export function standingReviewHash(
  events: readonly ChainEvent[],
  reportedEvent: string,
  isReview: (e: ChainEvent) => boolean,
  sameSubject: (data: Raw) => boolean = () => true,
): string | undefined {
  for (const e of events) {
    if (e.name.toLowerCase() === reportedEvent.toLowerCase() && sameSubject(e.data)) return undefined;
    if (!isReview(e)) continue;
    try { return hex(e.data, "report_hash"); } catch { return undefined; }
  }
  return undefined;
}

/** The owner's death review that stands: the one that gave the claim's current verdict. */
export function deathReviewHash(events: readonly ChainEvent[], death: { certHash: string | null; verdict: string }): string | undefined {
  if (!death.certHash || (death.verdict !== "Approved" && death.verdict !== "Referred")) return undefined;
  const want = death.verdict === "Approved" ? "deathreviewed" : "reviewreferred";
  return standingReviewHash(events, "DeathClaimSubmitted", (e) => e.name.toLowerCase() === want
    // ReviewReferred also reports claims and hardships.
    && (want === "deathreviewed" || Object.keys((e.data.kind as object | undefined) ?? {})[0]?.toLowerCase() === "unlock"));
}
