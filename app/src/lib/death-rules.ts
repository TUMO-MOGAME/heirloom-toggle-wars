/**
 * The program's rules for quorums and replaceable reports (docs/program-spec.md "Second security review"), shared by
 * the mock, the chain service and the screens so that all three say the same thing. Pure.
 */
import type { Base58, Verdict } from "./types";

export const MIN_WAIT_SECS = 60;
export const MAX_REPORT_GRACE_SECS = 86_400;
const REFERRED_MIN = 2;
const EMPTY_WALLET = "11111111111111111111111111111111";

/** Seat indexes that may decide: held, and not by whoever would gain. */
export function eligibleSeats(verifiers: readonly (Base58 | null)[], interested?: Base58 | null): number[] {
  return verifiers.flatMap((v, i) => (v && v !== EMPTY_WALLET && v !== interested ? [i] : []));
}

/**
 * Estate::deciders. The seats that decide a death claim or a claim: held, not by whoever gains, unless nobody else
 * holds a seat and the agent approved (never referred). Then the one who gains decides alone (DECIDED_ALONE: twice the
 * wait, or twice the objection window). Never for a hardship.
 */
export function deciders(verifiers: readonly (Base58 | null)[], interested: Base58 | null | undefined, verdict: Verdict): number[] {
  const others = eligibleSeats(verifiers, interested);
  return others.length || verdict !== "Approved" ? others : eligibleSeats(verifiers);
}

/** The one who gains may decide alone (see `deciders`). */
export const decidesAlone = (verifiers: readonly (Base58 | null)[], who: Base58 | null | undefined, verdict: Verdict) =>
  !!who && !eligibleSeats(verifiers, who).length && verdict === "Approved" && verifiers.includes(who);

/**
 * Approvals needed and given. `needed` 0: nobody may decide, so it can never be met. `alone`: the death claim's and a
 * claim's lone route (`deciders`); a hardship has none.
 */
export function quorum(input: {
  verifiers: readonly (Base58 | null)[]; votes: readonly boolean[]; threshold: number; verdict: Verdict; interested?: Base58 | null; alone?: boolean;
}): { needed: number; got: number; met: boolean } {
  const eligible = input.alone ? deciders(input.verifiers, input.interested, input.verdict) : eligibleSeats(input.verifiers, input.interested);
  const wanted = input.verdict === "Referred" ? Math.max(input.threshold, REFERRED_MIN) : input.threshold;
  const needed = Math.min(wanted, eligible.length);
  const got = eligible.filter((i) => input.votes[i]).length;
  return { needed, got, met: needed > 0 && got >= needed };
}

/** Death claim: how long a reviewed report keeps its place (Estate::reviewed_hold). */
export const reviewedHold = (waitingSecs: number) => 2 * Math.max(waitingSecs, MIN_WAIT_SECS);

/** RT: how long an unanswered step waits before a recovery route opens (Estate::recovery_timeout). */
export const recoveryTimeout = (waitingSecs: number) => 2 * reviewedHold(waitingSecs);

/** Seat death: a reviewed report stands long enough for the recovery route to open and be used (RT + 2W). */
export const seatReviewedHold = (waitingSecs: number) => recoveryTimeout(waitingSecs) + reviewedHold(waitingSecs);

/** How long an unreviewed report keeps its place: the waiting period, 60 s to a day (Estate::report_grace). */
export const reportGrace = (waitingSecs: number) => Math.min(Math.max(waitingSecs, MIN_WAIT_SECS), MAX_REPORT_GRACE_SECS);

/** Fallback death: an unreviewed report keeps its place for at most half the refute wait. */
export const fallbackGrace = (waitingSecs: number, fallbackWaitSecs: number) =>
  Math.min(reportGrace(waitingSecs), Math.floor(refuteWait(fallbackWaitSecs) / 2));

/** Fallback death: how long the person reported has to refute before anyone can confirm. */
export const refuteWait = (fallbackWaitSecs: number) => Math.max(fallbackWaitSecs, MIN_WAIT_SECS);

/** Never: an unreviewed death claim waits for the agent's review (or a lost agent is replaced, then reviews it). */
export const NEVER = Number.POSITIVE_INFINITY;

/**
 * From when `who` may replace an unconfirmed report. `hold` is reviewedHold(waiting), or for a fallback death twice
 * refuteWait(fallback wait). Whoever made the report waits one grace longer. `grace`: reportGrace(waiting) unless
 * given (a fallback death's is fallbackGrace). `death`: the owner's death claim, which is never replaced while
 * unreviewed (NEVER), so its time stays when this death's first claim was made; a disproved one is replaced at once
 * (lib/guardians/decisions.ts deathDisproved).
 */
export function replaceableAt(input: {
  verdict: Verdict; reportedAt: number; reporter: Base58 | null; who: Base58; waitingSecs: number; hold: number; grace?: number; death?: boolean;
}): number {
  if (input.death && input.verdict === "Pending") return NEVER;
  const grace = input.grace ?? reportGrace(input.waitingSecs);
  const base = input.verdict === "Pending" ? grace : input.hold;
  return input.reportedAt + base + (input.reporter === input.who ? grace : 0);
}

/** False: the claim was made under a rule that held this slot before it was reused. */
export const isCurrentClaim = (claimId: number, ruleClaimCount: number) => claimId >>> 16 === ruleClaimCount >>> 16;

/** How long the unlock waits once the death is confirmed: twice the waiting period when it was decided alone. */
export const unlockWaitSecs = (e: { waitingPeriodSecs: number; death: { decidedAlone?: boolean } }) =>
  Math.max(e.waitingPeriodSecs, MIN_WAIT_SECS) * (e.death.decidedAlone ? 2 : 1);
