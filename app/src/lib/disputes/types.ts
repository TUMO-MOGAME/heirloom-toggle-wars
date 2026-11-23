/**
 * Disputes (U9) and yearly caps, added 15 Nov 2026. Mirrors docs/program-spec.md ("Disputes and yearly caps").
 *
 * A dispute freezes a pending claim payment or a pending unlock (the death waiting period). Any beneficiary or trusted
 * person (verifier) can raise one with a short written reason; only the reason's SHA-256 goes on-chain. Two of the
 * three trusted people resolve it: uphold (the action is cancelled) or dismiss (it continues). It lapses after the
 * estate's waiting period (at least 60 s), so a dispute can never lock funds forever.
 *
 * On-chain a dispute is an Objection in the `["objection", target]` PDA with seat_index 254, so a target has either a
 * monitor's objection or a dispute, never both at once, and each claim (or each waiting period) is challenged once.
 */
import type { Base58 } from "../types";
import type { TxResult } from "../service/types";

export type DisputeKind = "Claim" | "Unlock";
/** "Lapsed" is not stored: an Open dispute past `lapsesAt` counts as dismissed. */
export type DisputeStatus = "Open" | "Upheld" | "Dismissed" | "Lapsed";

/** `Objection.seat_index` of a dispute on-chain. */
export const DISPUTE_SEAT = 254;
/** A dispute lapses after max(estate.waiting_period_secs, 60 s). */
export const DISPUTE_MIN_SECS = 60;
/** One yearly-cap period: 365 days. */
export const YEAR_SECS = 365 * 86_400;

export interface Dispute {
  /** The Objection PDA. */
  address: Base58;
  kind: DisputeKind;
  /** Claim PDA (Claim) or the estate (Unlock). */
  target: Base58;
  disputer: Base58;
  disputerName: string;
  /** Off-chain text; only its hash is on-chain. Empty when this device doesn't know it. */
  reason: string;
  reasonHash: string;
  raisedAt: number;
  lapsesAt: number;
  status: DisputeStatus;
  votesUphold: number;
  votesDismiss: number;
  /** Verifier indexes that have voted (either way). */
  voted: number[];
}

/** A rule's cap per 12-month period ("school fees up to N USD₮ a year"); absent = no yearly cap. */
export interface YearlyCap {
  cap: bigint;
  /** The period as last recorded, and its end (periodStart + 365 days). Use `currentPeriod` for "now". */
  periodStart: number;
  periodEnd: number;
  /** Paid in that period. */
  spent: bigint;
}

export interface DisputesService {
  /** Beneficiary or trusted person: freeze a pending claim payment or a pending unlock. */
  raiseDispute(estate: Base58, input: { kind: DisputeKind; target: Base58; reason: string }): Promise<TxResult>;
  /** Trusted person (not the one who raised it): uphold = cancel the action; dismiss = let it continue. */
  resolveDispute(estate: Base58, dispute: Base58, uphold: boolean): Promise<TxResult>;
  /** Owner, estate Active: set or change a rule's yearly cap. `periodStart` (unix secs, not in the future) defaults to now. */
  setYearlyCap(estate: Base58, rule: Base58, input: { capUsdt: number; periodStart?: number }): Promise<TxResult>;
}

/** Status the program acts on: an Open dispute past its lapse time counts as dismissed. */
export function effectiveStatus(d: Pick<Dispute, "status" | "lapsesAt">, now: number): DisputeStatus {
  return d.status === "Open" && now >= d.lapsesAt ? "Lapsed" : d.status;
}

export const disputeLapsesAt = (raisedAt: number, waitingPeriodSecs: number) => raisedAt + Math.max(waitingPeriodSecs, DISPUTE_MIN_SECS);

/** The open (binding) dispute on `target`, if any. */
export function openDisputeOn(disputes: Dispute[] | undefined, target: Base58, now: number): Dispute | null {
  return disputes?.find((d) => d.target === target && effectiveStatus(d, now) === "Open") ?? null;
}

/** Disputes this trusted person (verifier index) has voted on, newest first: the Inbox lists them under Handled. */
export function disputesVotedBy(disputes: Dispute[] | undefined, verifierIndex: number): Dispute[] {
  if (verifierIndex < 0) return [];
  return (disputes ?? []).filter((d) => d.voted.includes(verifierIndex)).sort((a, b) => b.raisedAt - a.raisedAt);
}

/** The latest dispute on `target` (any status). */
export function disputeOn(disputes: Dispute[] | undefined, target: Base58): Dispute | null {
  return [...(disputes ?? [])].filter((d) => d.target === target).sort((a, b) => b.raisedAt - a.raisedAt)[0] ?? null;
}

/** The yearly period containing `now`, rolled forward from the stored one, as the program does. */
export function currentPeriod(cap: bigint, periodStart: number, spent: bigint, now: number): YearlyCap {
  if (now < periodStart + YEAR_SECS) return { cap, periodStart, periodEnd: periodStart + YEAR_SECS, spent };
  const start = periodStart + Math.floor((now - periodStart) / YEAR_SECS) * YEAR_SECS;
  return { cap, periodStart: start, periodEnd: start + YEAR_SECS, spent: 0n };
}

/** How much more the yearly cap allows right now (null = no yearly cap). */
export function yearlyLeft(y: YearlyCap | null | undefined, now: number): bigint | null {
  if (!y) return null;
  const p = currentPeriod(y.cap, y.periodStart, y.spent, now);
  return p.cap > p.spent ? p.cap - p.spent : 0n;
}

/** A monitors' objection (not Fallback) lapses after two waiting periods (state.rs `lapses_at`). */
export const objectionLapsesAt = (raisedAt: number, waitingPeriodSecs: number) =>
  raisedAt + 2 * Math.max(waitingPeriodSecs, DISPUTE_MIN_SECS);
