/**
 * Read side of disputes (U9) and yearly caps (docs/program-spec.md, "Disputes and yearly caps"). A dispute is an
 * Objection account with seat_index 254; a yearly cap is a YearCap account at ["yearcap", rule]. Decoding is pure;
 * fetchDisputesRaw uses the shared program scan (reads.ts), so it adds no RPC calls of its own.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Base58, Estate, Rule } from "../types";
import { DISPUTE_SEAT, YEAR_SECS, disputeLapsesAt, type Dispute, type DisputeKind, type YearlyCap } from "../disputes/types";
import { eligibleSeats } from "../death-rules";
import { shortAddress } from "../format";
import { accountName, getCoder, getIdl } from "./idl";
import { big, bits, enumOf, hex, key, num, type Raw } from "./decoders";
import { scanAccounts } from "./reads";
import { getConnection } from "./tx";

const TARGET_KIND = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"] as const;
const STATUS = ["Open", "Upheld", "Dismissed"] as const;

const hasAccount = (name: string) => !!getIdl().accounts?.some((a) => a.name.toLowerCase() === name.toLowerCase());
function decode(type: string, data: Uint8Array): Raw {
  return getCoder().accounts.decode(accountName(type), data as Parameters<ReturnType<typeof getCoder>["accounts"]["decode"]>[1]) as Raw;
}

export interface RawDisputes {
  /** Objection accounts of this estate with seat_index 254. */
  disputes: { address: Base58; raw: Raw }[];
  /** rule address → YearCap account. */
  yearCaps: Record<Base58, Raw>;
}

/** Is this Objection account a dispute? */
export const isDisputeRaw = (o: Raw) => num(o, "seat_index") === DISPUTE_SEAT;

/** Objection (seat_index 254) → Dispute. Unknown reasons (raised on another device) stay empty. */
export function decodeDispute(address: Base58, o: Raw, estate: Estate, names: Record<Base58, string>, reasons: Record<string, string>): Dispute {
  const kind = enumOf(o, "kind", TARGET_KIND);
  if (kind !== "Claim" && kind !== "Unlock") throw new Error(`A dispute on a ${kind} is not supported`);
  const disputer = key(o, "monitor");
  const reasonHash = hex(o, "reason_hash");
  const raisedAt = num(o, "raised_at");
  const up = num(o, "votes_uphold");
  const down = num(o, "votes_dismiss");
  const voted = bits(up | down, 3).map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  // A vacant seat's vote no longer counts. A challenge to an unlock from before the owner's last sign of life is void.
  const seats = eligibleSeats(estate.verifiers);
  const counted = (mask: number) => seats.filter((i) => mask & (1 << i)).length;
  // Voided by a new report (raised_at 0), or an unlock challenge raised before the owner's last sign of life. Once
  // decided, raised_at is when it was decided.
  const voided = raisedAt === 0 || (kind === "Unlock" && raisedAt < estate.lastHeartbeat);
  return {
    address, kind: kind as DisputeKind, target: key(o, "target"), disputer,
    disputerName: names[disputer] ?? (estate.verifiers.includes(disputer) ? estate.verifierNames[estate.verifiers.indexOf(disputer)] : shortAddress(disputer)),
    reason: reasons[reasonHash] ?? "", reasonHash, raisedAt, lapsesAt: voided ? raisedAt : disputeLapsesAt(raisedAt, estate.waitingPeriodSecs),
    status: enumOf(o, "status", STATUS), votesUphold: counted(up), votesDismiss: counted(down), voted,
  };
}

/** YearCap account → the rule's YearlyCap (as last recorded). */
export function decodeYearCap(r: Raw): YearlyCap {
  const periodStart = num(r, "period_start");
  return { cap: big(r, "cap"), periodStart, periodEnd: periodStart + YEAR_SECS, spent: big(r, "period_spent") };
}

/** Disputes and yearly caps of one estate. Older IDLs (no YearCap / dispute instructions) give empty results. */
export async function fetchDisputesRaw(estate: Base58, rules: Base58[], conn: Connection = getConnection()): Promise<RawDisputes> {
  const out: RawDisputes = { disputes: [], yearCaps: {} };
  if (!hasAccount("Objection")) return out;
  const estateKey = new PublicKey(estate);
  const [objections, caps] = await Promise.all([
    scanAccounts("Objection", [{ offset: 8, key: estateKey }], conn),
    hasAccount("YearCap") ? scanAccounts("YearCap", [], conn) : Promise.resolve([]),
  ]);
  for (const a of objections) {
    const raw = decode("Objection", a.data);
    if (isDisputeRaw(raw)) out.disputes.push({ address: a.pubkey.toBase58(), raw });
  }
  const wanted = new Set(rules);
  for (const a of caps) {
    const raw = decode("YearCap", a.data);
    const rule = key(raw, "rule");
    if (wanted.has(rule)) out.yearCaps[rule] = raw;
  }
  return out;
}

/** Joins the raw accounts into the snapshot's disputes (newest first) and each rule's yearly cap. Pure. */
export function assembleDisputes(raw: RawDisputes, ctx: { estate: Estate; rules: Rule[]; names: Record<Base58, string>; reasons: Record<string, string> }): { disputes: Dispute[]; rules: Rule[] } {
  const disputes = raw.disputes.flatMap(({ address, raw: o }) => {
    try { return [decodeDispute(address, o, ctx.estate, ctx.names, ctx.reasons)]; } catch { return []; }
  }).sort((a, b) => b.raisedAt - a.raisedAt);
  const rules = ctx.rules.map((r) => (raw.yearCaps[r.address] ? { ...r, yearlyCap: decodeYearCap(raw.yearCaps[r.address]) } : r));
  return { disputes, rules };
}
