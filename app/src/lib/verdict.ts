/**
 * The agent's verdict as the program reads it (state.rs `Verdict`). "Referred": the agent could not decide, so people
 * do, and it takes at least two of them. One place for the rule, used by both services and every screen.
 */
import type { Verdict } from "./types";

export const REFERRED_MIN_APPROVALS = 2;

/** What review_death, review_claim and review_hardship take (state.rs `ReviewOutcome`). */
export type ReviewOutcome = "Reject" | "Approve" | "Refer";

/** The agent looked and did not reject: people may now decide. */
export const openToPeople = (v: Verdict): boolean => v === "Approved" || v === "Referred";

/** Approvals needed, given the estate's threshold. */
export const quorumFor = (v: Verdict, threshold: number): number =>
  v === "Referred" ? Math.max(threshold, REFERRED_MIN_APPROVALS) : threshold;

/** The agent's report as an on-chain outcome. An unsure agent never approves. */
export const outcomeOf = (verdict: "approve" | "reject" | "needs_human"): ReviewOutcome =>
  verdict === "approve" ? "Approve" : verdict === "reject" ? "Reject" : "Refer";
