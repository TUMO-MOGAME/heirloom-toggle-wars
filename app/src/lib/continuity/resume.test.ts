import { describe, expect, it } from "vitest";
import { rulesStillToAdd } from "./resume";
import { toBase } from "../format";
import type { WillDraft } from "../types";

const rule = {
  beneficiaryLabel: "Zanele", category: "Tuition", allowedPayeeKind: "University",
  maxPerClaimUsdt: 50, lifetimeCapUsdt: 200, validUntil: "2029-12-31", startsNow: true,
} as WillDraft["rules"][number];
const people = [{ label: "Zanele", relationship: "daughter", wallet: "Z" }] as WillDraft["beneficiaries"];
const onChain = {
  beneficiary: "Z", category: "Tuition" as const, allowedPayeeKind: "University" as const,
  maxPerClaim: toBase(50), lifetimeCap: toBase(200), validUntil: Math.floor(Date.parse("2029-12-31") / 1000), startsNow: true,
};

describe("rulesStillToAdd", () => {
  it("adds everything the first time", () => expect(rulesStillToAdd([rule], people, [])).toEqual([rule]));
  it("never adds a rule twice on a retry", () => expect(rulesStillToAdd([rule], people, [onChain])).toEqual([]));
  it("still adds a second identical rule the plan asks for", () => expect(rulesStillToAdd([rule, rule], people, [onChain])).toEqual([rule]));
});
