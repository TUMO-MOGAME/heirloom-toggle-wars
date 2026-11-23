/**
 * Shared types for guardians (trusted-person seats with backups and monitors), objections, succession, the fallback
 * plan and asset photos. Source of truth for the UI (Agent C, D) and the service layer (Agent B); mirrors
 * docs/guardians-spec.md and the on-chain accounts (Agent A). Amounts are base units (6 dp) like the rest of lib/types.
 */
import type { AgentReport, Base58 } from "../types";
import type { TxResult } from "../service/types";
import type { AssetSpec, PhotoLabel } from "../assets/spec";

export type TargetKind = "Claim" | "Unlock" | "Sale" | "Hardship" | "Succession" | "Fallback";
export type ObjectionStatus = "Open" | "Upheld" | "Dismissed";
export type AssetKind = "Car" | "Motorbike" | "Furniture" | "Jewellery" | "Electronics" | "Other";

export interface Seat {
  address: Base58;
  index: number;                    // 0..2
  holder: Base58 | null;            // null when vacant
  holderName: string;               // off-chain display name ("Uncle Bongani Mokoena")
  backups: { wallet: Base58; name: string }[];   // 0..2, in promotion order
  monitors: { wallet: Base58; name: string }[];  // 0..2
  generation: number;
  vacant: boolean;
  succession: SeatSuccession | null;
}

export interface SeatSuccession {
  certHash: string;                 // hex SHA-256
  reportedBy: Base58;
  verdict: "Pending" | "Approved" | "Rejected";
  report?: AgentReport;
  confirmedBy: Base58 | null;
  /** When it was reported (0 = before times were stored). See death-rules.ts for when it may be replaced. */
  reportedAt?: number;
  pendingSince: number;             // unix seconds the wait started (at confirmation); 0 until confirmed
  readyAt: number;                  // pendingSince + successionWaitSecs; 0 until confirmed
  nextHolder: { wallet: Base58; name: string } | null;  // backups[0] (or [1]); null = seat becomes vacant
}

/** One approval a seat holder made; what a monitor watches. From the SeatApproval event. */
export interface SeatApprovalItem {
  seatIndex: number;
  approver: Base58;
  approverName: string;
  kind: TargetKind;
  target: Base58;
  summary: string;                  // "Approved 3 500 USD₮ to University of Cape Town for Lerato"
  ts: number;
  txSignature?: string;
  objectionDeadline: number | null; // after this an objection can no longer pause it (claims: approved_at + window)
}

export interface Objection {
  address: Base58;
  kind: TargetKind;
  target: Base58;
  monitor: Base58;
  monitorName: string;
  seatIndex: number | null;
  reason: string;                   // off-chain text; only its hash is on-chain
  reasonHash: string;
  raisedAt: number;
  status: ObjectionStatus;
  votesUphold: number;              // count of votes
  votesDismiss: number;
  /** Fallback objections only, while Open: when it lapses (counts as dismissed) unless upheld; else null. Added by Agent B. */
  lapsesAt?: number | null;
}

export interface FallbackRecipient {
  wallet: Base58;
  name: string;                     // "Lerato (daughter)", "Mokoena Family Trust", "Ithemba Children's Charity"
  kind: "family" | "heir" | "charity";
  dead: boolean;                    // proven dead (family/heir only)
  /** An open report that they died: the agent reviews, then a second person confirms, or they refute. */
  report?: FallbackDeathReport | null;
}

export interface FallbackDeathReport {
  reporter: Base58;
  certHash: string;
  verdict: "Pending" | "Approved";
  reportedAt: number;
  /** reportedAt + max(fallback wait, 60 s): a second person may confirm from here. */
  confirmableAt: number;
  report?: AgentReport;
}

export interface FallbackPlan {
  recipients: FallbackRecipient[];  // ordered, up to 4
  startedAt: number | null;
  readyAt: number | null;           // startedAt + fallbackWaitSecs
  done: boolean;
  /** True when every seat is vacant and the owner's death is proven: anyone may start the fallback. */
  canStart: boolean;
}

export interface GuardiansSnapshot {
  enabled: boolean;                 // a Guard account exists (older estates: false, everything below empty)
  /** The Guard account: the target of a Fallback objection (an Unlock objection targets the estate). Added by Agent B. */
  address?: Base58;
  objectionWindowSecs: number;
  successionWaitSecs: number;
  fallbackWaitSecs: number;
  seats: Seat[];
  feed: SeatApprovalItem[];         // newest first
  /**
   * Claim address -> unix seconds when its objection window ends and it can be paid (from its ApprovalStamp).
   * Only claims approved by trusted people while a Guard exists; absent = no window applies. Added by Agent B.
   */
  claimPayableAt?: Record<Base58, number>;
  objections: Objection[];
  fallback: FallbackPlan;
}

/** One photo of an asset. `label` (Front, Engine, …) groups the gallery; photo 0 is the cover. */
export interface AssetPhoto { sha256: string; url: string; width: number; height: number; bytes: number; label?: PhotoLabel }
export interface AssetMediaInfo {
  asset: Base58; kind: AssetKind; title: string; photos: AssetPhoto[]; photosRoot: string; updatedAt: number;
  /** Off-chain description shown to buyers. Added by Agent B for Agent D. */
  description?: string;
  /** Spec sheet (key facts, details, condition, performance), off-chain; its hash is part of photosRoot. */
  spec?: AssetSpec;
  /** Chain mode: true when the listed photos hash to the on-chain AssetMedia.photos_root; undefined when nothing is on-chain. */
  onChainMatch?: boolean;
}

export interface AssetMediaInput { kind: AssetKind; title: string; photos: AssetPhoto[]; description?: string; spec?: AssetSpec }

/** Methods the UI calls. Implemented by mock.ts and chain.ts (Agent B); HeirloomService extends this. */
export interface GuardiansService {
  getGuardians(estate: Base58): Promise<GuardiansSnapshot>;
  // owner (estate Active)
  setupGuardians(estate: Base58, input: {
    seats: { index: number; backups: { wallet: Base58; name: string }[]; monitors: { wallet: Base58; name: string }[] }[];
    fallback: { wallet: Base58; name: string; kind: FallbackRecipient["kind"] }[];
  }): Promise<TxResult[]>;
  setSeatBackups(estate: Base58, index: number, backups: { wallet: Base58; name: string }[]): Promise<TxResult>;
  setSeatMonitors(estate: Base58, index: number, monitors: { wallet: Base58; name: string }[]): Promise<TxResult>;
  /**
   * owner_replace_seat: the owner (estate Active) puts someone new in seat `index` (also fills an empty seat). The new
   * holder must be set, not the owner and not hold any seat (DuplicateVerifier). The seat keeps its backups and
   * monitors, minus the new holder if they were one; any reported passing on it is cleared; generation += 1.
   */
  ownerReplaceSeat(estate: Base58, index: number, newHolder: { wallet: Base58; name: string }): Promise<TxResult>;
  setFallback(estate: Base58, recipients: { wallet: Base58; name: string; kind: FallbackRecipient["kind"] }[]): Promise<TxResult>;
  // succession
  reportSeatDeath(estate: Base58, index: number, certificate: File): Promise<{ /** Null when nothing was signed: a resumed report whose review the agent did not sign (an unnamed person). */ tx: TxResult | null; report: AgentReport }>;
  confirmSeatDeath(estate: Base58, index: number): Promise<TxResult>;
  vetoSeatDeath(estate: Base58, index: number): Promise<TxResult>;
  finalizeSuccession(estate: Base58, index: number): Promise<TxResult>;
  // monitors and objections
  raiseObjection(estate: Base58, input: { kind: TargetKind; target: Base58; seatIndex: number | null; reason: string }): Promise<TxResult>;
  voteObjection(estate: Base58, objection: Base58, uphold: boolean): Promise<TxResult>;
  // fallback
  reportFallbackDeath(estate: Base58, recipientIndex: number, certificate: File): Promise<{ /** Null when nothing was signed: a resumed report whose review the agent did not sign (an unnamed person). */ tx: TxResult | null; report: AgentReport }>;
  /** dead: a second participant confirms. Otherwise the reported recipient says "I'm alive". */
  resolveFallbackDeath(estate: Base58, recipientIndex: number, dead: boolean): Promise<TxResult>;
  startFallback(estate: Base58): Promise<TxResult>;
  /** Anyone: marks an Open Fallback objection that was not upheld in time as lapsed (dismissed). Added by Agent B. */
  lapseObjection(estate: Base58): Promise<TxResult>;
  executeFallback(estate: Base58): Promise<TxResult>;
  // asset photos (Agent D uploads; B records the root on-chain)
  getAssetMedia(estate: Base58): Promise<AssetMediaInfo[]>;
  /** Records the media root (photos + labels + spec sheet, lib/assets/spec.ts mediaRootHex) on-chain; ≤ 24 photos. */
  setAssetMedia(estate: Base58, asset: Base58, input: AssetMediaInput): Promise<TxResult>;
}
