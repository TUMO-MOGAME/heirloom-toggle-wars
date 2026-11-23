/**
 * What several mock instructions share, as in programs/heirloom (state.rs, instructions/mod.rs): clearing a death
 * claim, proof of life, and whether a claim's approvals count.
 */
import type { Claim, Estate } from "../types";
import type { TxResult } from "./types";
import { deathOpen, deathSince } from "../guardians/decisions";

/** `ApprovalStamp.seat_index` while approvals are being collected. */
export const COLLECTING = 255;

export interface MockStamp {
  seatIndex: number;
  approver: string;
  /** When the quorum was reached (0: not yet). The demo's "end the window" moves it back. */
  approvedAt: number;
  /** The same, never moved: what "given after this death" is read from. */
  givenAt?: number;
  /** The demo ended the window, so a dispute's extra wait is over as well. */
  windowEnded?: boolean;
}

export function clearDeath(e: Estate) {
  e.death = { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null, submittedAt: null };
}

/** record_proof_of_life: the owner signed in person, so any death claim is void (R1, R2). */
export function proofOfLife(e: Estate, now: number, log: (kind: string, text: string, t: TxResult) => void, tx: () => TxResult) {
  e.lastHeartbeat = now;
  if (!deathOpen(e)) return;
  clearDeath(e);
  e.status = "Active";
  log("DeathVetoed", "The owner showed they are alive, so the reported passing was cancelled", tx());
}

/** ApprovalStamp::votes_count: given after this death (R3). */
export function votesCount(stamp: MockStamp | undefined, claim: Claim, e: Estate): boolean {
  const since = deathSince(e);
  if (claim.createdAt > since) return true;
  if (!stamp) return false;
  return stamp.approvedAt === 0 ? stamp.seatIndex === COLLECTING : (stamp.givenAt ?? stamp.approvedAt) >= since;
}
