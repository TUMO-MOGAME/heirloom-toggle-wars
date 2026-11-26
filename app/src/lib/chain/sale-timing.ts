/**
 * What accept_offer checks against the clock, read from the chain (docs/program-spec.md "Challenges"): with a Guard
 * an offer, and a standing hardship's quorum, wait out the objection window; an offer made at or before an upheld
 * objection to the sale was decided is refused (OfferTooOld), also after a later one was dismissed or lapsed (P5). The browser and the server read the same accounts, so
 * both rank the same offer best (lib/agent/offers.ts).
 */
import { PublicKey } from "@solana/web3.js";
import type { Base58 } from "../types";
import type { SaleTiming } from "../agent/offers";
import { getIdl } from "./idl";
import { enumOf, num, type Raw } from "./decoders";
import { guardPda, hardshipPda, objectionPda, stampPda } from "./pda";
import { fetchAccountRaw } from "./reads";

/** Guard::objection_window clamps the stored window on read. */
const MAX_GUARD_WAIT_SECS = 180 * 86_400;
/** High bit of a Sale objection's votes_uphold: an earlier objection to the sale was upheld (P5). Seat votes use bits 0..2. */
export const SALE_CUTOFF_KEPT = 1 << 7;

/** Pure: the timing from the Guard, the sale's ["objection", asset] and the hardship's ["stamp", hardship] (each may be missing). */
export function saleTimingFrom(raw: { guard: Raw | null; saleObjection: Raw | null; hardshipStamp: Raw | null }, now: number): SaleTiming {
  const o = raw.saleObjection;
  // Objection::sale_cutoff: upheld, or re-raised after one was upheld (dismissed or lapsed since: the cut-off stays, P5).
  const kept = !!o && o.votes_uphold !== undefined && (num(o, "votes_uphold") & SALE_CUTOFF_KEPT) !== 0;
  const upheld = o && (enumOf(o, "status", ["Open", "Upheld", "Dismissed"] as const) === "Upheld" || kept);
  const quorumAt = raw.hardshipStamp ? num(raw.hardshipStamp, "approved_at") : 0;
  return {
    now,
    objectionWindowSecs: raw.guard ? Math.min(MAX_GUARD_WAIT_SECS, Math.max(0, num(raw.guard, "objection_window_secs"))) : null,
    saleObjectionUpheldAt: upheld ? num(o, "raised_at") : null,
    hardshipQuorumAt: quorumAt > 0 ? quorumAt : null,
  };
}

export async function loadSaleTiming(
  estate: Base58, asset: { address: Base58; hardshipBeneficiary: Base58 | null }, now = Math.floor(Date.now() / 1000),
): Promise<SaleTiming> {
  const programId = new PublicKey(getIdl().address);
  const hardship = asset.hardshipBeneficiary ? hardshipPda(programId, asset.address, asset.hardshipBeneficiary) : null;
  const [guard, saleObjection, hardshipStamp] = await Promise.all([
    fetchAccountRaw("Guard", guardPda(programId, estate).toBase58()),
    fetchAccountRaw("Objection", objectionPda(programId, asset.address).toBase58()),
    hardship ? fetchAccountRaw("ApprovalStamp", stampPda(programId, hardship).toBase58()) : Promise.resolve(null),
  ]);
  return saleTimingFrom({ guard, saleObjection, hardshipStamp }, now);
}
