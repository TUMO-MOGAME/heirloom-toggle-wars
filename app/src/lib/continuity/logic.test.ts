import { describe, expect, it } from "vitest";
import { clampDeathWaiting, clampWaiting, listingEnded, nextDueAfter, orphanRules, reservedByRules, residualRecipient, surplusOf, sweepableSurplus } from "./logic";
import { missingPeople, practicePayees, withWallets } from "./practice";
import { openToPeople, outcomeOf, quorumFor } from "../verdict";
import type { WillDraft } from "../types";

describe("what is left (mirrors sweep_residual)", () => {
  const rules = [
    { validUntil: 200, lifetimeCap: 1_000n, spentTotal: 600n },
    { validUntil: 50, lifetimeCap: 900n, spentTotal: 0n }, // ended
  ];
  it("reserves only what live rules can still pay", () => {
    expect(reservedByRules(rules, 100)).toBe(400n);
    expect(surplusOf(5_000n, rules, 100)).toBe(4_600n);
    expect(surplusOf(300n, rules, 100)).toBe(0n);
    expect(surplusOf(300n, rules, 201)).toBe(300n);
  });

  it("pays the named person, else the first living fallback recipient, else nobody", () => {
    expect(residualRecipient("heir", null, "0")).toBe("heir");
    expect(residualRecipient(null, { wallets: ["a", "b", "0", "0"], deadMask: 1 }, "0")).toBe("b");
    expect(residualRecipient(null, { wallets: ["0", "0", "0", "0"], deadMask: 0 }, "0")).toBeNull();
    expect(residualRecipient(null, null, "0")).toBeNull();
  });
});

describe("schedules and waits", () => {
  it("missed dates never pay together", () => {
    expect(nextDueAfter(100, 30, 100)).toBe(130);
    expect(nextDueAfter(100, 30, 129)).toBe(130);
    expect(nextDueAfter(0, 30, 361)).toBe(390);
  });
  it("keeps the waiting period inside the program's bounds", () => {
    expect(clampWaiting(0)).toBe(60);
    expect(clampWaiting(300)).toBe(300);
    expect(clampWaiting(9e9)).toBe(365 * 86_400);
  });
  it("only an ended listing can be listed again", () => {
    expect(listingEnded({ status: "Listed", listingEnds: 100 }, 100)).toBe(true);
    expect(listingEnded({ status: "Listed", listingEnds: 100 }, 99)).toBe(false);
    expect(listingEnded({ status: "Sold", listingEnds: 100 }, 500)).toBe(false);
  });
});

describe("referred", () => {
  it("an unsure agent never approves", () => {
    expect(outcomeOf("needs_human")).toBe("Refer");
    expect(outcomeOf("approve")).toBe("Approve");
    expect(outcomeOf("reject")).toBe("Reject");
  });
  it("opens to people, with at least two of them", () => {
    expect(openToPeople("Referred")).toBe(true);
    expect(openToPeople("Pending")).toBe(false);
    expect(openToPeople("Rejected")).toBe(false);
    expect([quorumFor("Referred", 1), quorumFor("Referred", 3), quorumFor("Approved", 1)]).toEqual([2, 3, 1]);
  });
});

describe("practice setup", () => {
  const draft = {
    beneficiaries: [{ label: "Lerato", relationship: "daughter" }],
    verifiers: [{ name: "Nomsa", role: "sister", wallet: "has-one" }, { name: "David", role: "executor" }],
    rules: [
      { allowedPayeeKind: "School", recurring: { payeeName: "Westerford" } },
      { allowedPayeeKind: "School" },
      { allowedPayeeKind: "University" },
    ],
  } as unknown as WillDraft;

  it("finds who has no wallet and fills them in without touching the others", () => {
    expect(missingPeople(draft).map((p) => p.key)).toEqual(["b0", "v1"]);
    const filled = withWallets(draft, { b0: "L", v1: "D", v0: "never" });
    expect(filled.beneficiaries[0].wallet).toBe("L");
    expect(filled.verifiers.map((v) => v.wallet)).toEqual(["has-one", "D"]);
    expect(missingPeople(filled)).toEqual([]);
  });

  it("makes a payee for every schedule and every kind, and none twice", () => {
    expect(practicePayees(draft.rules)).toEqual([{ name: "Westerford", kind: "School" }, { name: "Practice University", kind: "University" }]);
    expect(practicePayees(draft.rules, [{ name: "westerford", kind: "School" }, { name: "UCT", kind: "University" }])).toEqual([]);
  });
});

describe("finalist hardening (plan §22.1)", () => {
  it("P1: a new estate's death wait is at least 5 minutes and at most a year", () => {
    expect([clampDeathWaiting(0), clampDeathWaiting(60), clampDeathWaiting(301), clampDeathWaiting(9e9)]).toEqual([300, 300, 301, 365 * 86_400]);
  });

  const people = [{ wallet: "kid", active: true }, { wallet: "gone", active: false }];
  const rules = [
    { beneficiary: "kid", validUntil: 200, lifetimeCap: 100n, spentTotal: 0n },
    { beneficiary: "gone", validUntil: 200, lifetimeCap: 300n, spentTotal: 50n },
    { beneficiary: "gone", validUntil: 50, lifetimeCap: 900n, spentTotal: 0n }, // ended already
    { beneficiary: "unknown", validUntil: 200, lifetimeCap: 10n, spentTotal: 0n }, // no Beneficiary on record: the program can't end it
  ];

  it("P3: only a live rule of a removed beneficiary is an orphan", () => {
    expect(orphanRules(rules, people, 100)).toEqual([rules[1]]);
    expect(orphanRules(rules, people, 300)).toEqual([]);
  });

  it("P3: the sweep pays an orphan's reserve too", () => {
    expect(surplusOf(1_000n, rules, 100)).toBe(640n);
    expect(sweepableSurplus(1_000n, rules, people, 100)).toBe(890n);
  });
});
