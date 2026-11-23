/**
 * Reporting a death when a report may already stand (R4-R6): the owner's, a trusted person's seat, a fallback
 * recipient. Pure, over the raw accounts; the program decides again. The times are death-rules.ts's.
 *
 * - "send": no report stands, or the one that does may be replaced by this person now.
 * - "resume": this person's own unreviewed report of this very file. Nothing is sent; only the review is asked again
 *   (a review that failed would otherwise lock the reporter out until their own report is stale).
 */
import { fallbackGrace, NEVER, refuteWait, replaceableAt, reviewedHold, seatReviewedHold } from "../death-rules";
import type { Base58, Verdict } from "../types";
import { enumOf, hex, key, keyArray, num, waitingOf, type Raw } from "../chain/decoders";
import { ChainServiceError, must } from "./chain-errors";

export type ReportStep = "send" | "resume";

const VERDICT = ["Pending", "Approved", "Rejected", "Referred"] as const;
const NOBODY = "11111111111111111111111111111111";
const NO_HASH = "0".repeat(64);
/** state.rs clamps it on read (the waiting period: decoders.ts waitingOf). */
const MAX_GUARD_WAIT = 180 * 86_400;

interface Standing { verdict: Verdict; reportedAt: number; reporter: Base58; hash: string }

function step(standing: Standing, who: Base58, hash: string, waitingSecs: number, hold: number, now: number, code: string, grace?: number, death = false): ReportStep {
  if (standing.verdict === "Pending" && standing.reporter === who && standing.hash === hash) return "resume";
  const at = replaceableAt({ verdict: standing.verdict, reportedAt: standing.reportedAt, reporter: standing.reporter, who, waitingSecs, hold, grace, death });
  if (now >= at) return "send";
  if (at === NEVER) throw new ChainServiceError(code, "A report is already open and the agent hasn't reviewed it yet, so it can't be replaced until it has.");
  const when = `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  throw new ChainServiceError(code, `A report is already open. You can replace it from ${when}, unless it is decided before then.`, at);
}

export function deathClaimStep(estate: Raw, who: Base58, hash: string, now: number): ReportStep {
  const status = enumOf(estate, "status", ["Active", "DeathPending", "Unlocked", "Frozen"] as const);
  const standing = hex(estate, "death_cert_hash");
  // Estate::death_disproved: the owner showed life after it, so anyone who may report replaces it at once, also while
  // DeathPending (submit_death_claim).
  const disproved = standing !== NO_HASH && status !== "Unlocked" && num(estate, "last_heartbeat") > num(estate, "death_pending_since");
  if (disproved && (status === "Active" || status === "DeathPending")) return "send";
  must(status === "Active", "BadStatus", "The passing was already confirmed, so there is nothing to report.");
  if (standing === NO_HASH) return "send";
  const verdict = enumOf(estate, "death_verdict", VERDICT);
  must(verdict === "Pending" || keyArray(estate, "verifiers").some((v) => v !== NOBODY),
    "BadStatus", "With no trusted people left the reviewed report stands: it is the proof the fallback plan needs.");
  const waiting = waitingOf(estate);
  return step(
    { verdict, reportedAt: num(estate, "death_pending_since"), reporter: key(estate, "death_submitted_by"), hash: standing },
    who, hash, waiting, reviewedHold(waiting), now, "BadStatus", undefined, true,
  );
}

export function seatReportStep(estate: Raw, seat: Raw, who: Base58, hash: string, now: number): ReportStep {
  const standing = hex(seat, "death_cert_hash");
  if (standing === NO_HASH) return "send";
  must(key(seat, "death_confirmed_by") === NOBODY, "SuccessionPending", "This passing is already confirmed, so the report can't be replaced.");
  const waiting = waitingOf(estate);
  return step(
    { verdict: enumOf(seat, "death_verdict", VERDICT), reportedAt: num(seat, "death_pending_since"), reporter: key(seat, "death_reported_by"), hash: standing },
    who, hash, waiting, seatReviewedHold(waiting), now, "SuccessionPending",
  );
}

/** `report`: the slot's FallbackReport, if there is one. It is void once the list names someone else there. */
export function fallbackReportStep(estate: Raw, guard: Raw, slot: number, report: Raw | null, who: Base58, hash: string, now: number): ReportStep {
  if (!report || key(report, "recipient") !== keyArray(guard, "fallback")[slot]) return "send";
  const waiting = waitingOf(estate);
  return step(
    { verdict: enumOf(report, "verdict", VERDICT), reportedAt: num(report, "reported_at"), reporter: key(report, "reporter"), hash: hex(report, "cert_hash") },
    who, hash, waiting, 2 * refuteWait(fallbackWaitOf(guard)), now, "BadStatus", fallbackGrace(waiting, fallbackWaitOf(guard)),
  );
}

export const fallbackWaitOf = (guard: Raw) => Math.min(MAX_GUARD_WAIT, Math.max(0, num(guard, "fallback_wait_secs")));

/** When a second person may confirm a fallback death: the recipient can refute until then, and until it is confirmed. */
export const confirmableFrom = (guard: Raw, report: Raw) => num(report, "reported_at") + refuteWait(fallbackWaitOf(guard));
