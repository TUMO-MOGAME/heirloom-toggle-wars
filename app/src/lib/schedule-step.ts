import type { Rule } from "./types";
import type { EstateSnapshot } from "./service/types";

/**
 * The demo walk's "schedule" step: a living schedule that has not paid yet and is due within a day. A schedule first
 * due later (Naledi's 500 USD₮ birthday gift in 2029, plan.md §16.5) is not a step of the walk.
 */
export function scheduleStepDue(rules: Rule[], nowS: number): boolean {
  return rules.some((r) => r.startsNow && r.recurringAmount > BigInt(0) && r.spentTotal === BigInt(0) && (r.nextDue === null || r.nextDue <= nowS + 86_400));
}

/**
 * The demo walk's "claim" step is done once a claim was made under the plan after the passing. An everyday request
 * from before it ("Ask for money", which carries a note) is not that step, so the walk doesn't skip the claim and its
 * approval.
 */
export function claimedAfterDeath(snap: Pick<EstateSnapshot, "estate" | "claims" | "asks">): boolean {
  const since = snap.estate.death.pendingSince ?? 0;
  return snap.claims.some((c) => !snap.asks?.[c.address] && c.createdAt >= since);
}
