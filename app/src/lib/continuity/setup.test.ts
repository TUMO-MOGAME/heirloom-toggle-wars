/** Before signing, and changing a signed plan (plan §18.4 U2, U5). */
import { describe, expect, it } from "vitest";
import type { Payee, Rule, WillDraft } from "../types";
import { rulesEndedByRemoval, slotToReuse } from "./logic";
import { checkTrusted, missingPayees, paidOnRequest } from "./practice";

const rent: WillDraft["rules"][number] = {
  beneficiaryLabel: "Lerato", category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaimUsdt: 450, lifetimeCapUsdt: 6000,
  validUntil: "2030-12-31", notes: "", startsNow: true, recurring: { amountUsdt: 450, every: "month", payeeName: "South Point" },
};

describe("a schedule is never downgraded (U2)", () => {
  it("names the payee that is missing", () => {
    expect(missingPayees([rent])).toEqual([{ index: 0, name: "South Point", kind: "Landlord" }]);
    expect(missingPayees([rent], [{ name: "South Point", kind: "School" }])).toHaveLength(1);
  });

  it("an approved payee of that name and kind, or a practice payee, fills it", () => {
    expect(missingPayees([rent], [{ name: "south point", kind: "Landlord" }])).toEqual([]);
    expect(missingPayees([rent], [], true)).toEqual([]);
  });

  it("practice can't fill a schedule with no payee name", () => {
    expect(missingPayees([{ ...rent, recurring: { ...rent.recurring!, payeeName: " " } }], [], true)).toHaveLength(1);
  });

  it("paid on request only as the owner's choice, with the same limits", () => {
    const changed = paidOnRequest(rent);
    expect(changed.recurring).toBeUndefined();
    expect(changed.lifetimeCapUsdt).toBe(6000);
    expect(rent.recurring).toBeDefined();
  });
});

describe("three different real trusted people", () => {
  const [T, O, Z] = ["Trusted1", "Owner1", "1".repeat(32)];
  const v = (name: string, wallet?: string) => ({ name, role: "", wallet });
  const check = (...verifiers: ReturnType<typeof v>[]) =>
    checkTrusted({ ownerName: "Thabo Mokoena", beneficiaries: [{ label: "Lerato Mokoena", relationship: "daughter" }], verifiers }, O);

  it("accepts three", () => expect(check(v("A One"), v("B Two"), v("C Three"))).toEqual({ problem: null, heirs: [] }));
  it.each([
    ["three", [v("A One"), v("B Two")]],
    ["three", [v("A One"), v("B Two"), v("C Three"), v("D Four")]],
    ["name", [v("A One"), v(" "), v("C Three")]],
    ["wallet", [v("A One", Z), v("B Two"), v("C Three")]],
    ["owner", [v("A One", O), v("B Two"), v("C Three")]],
    ["owner", [v("thabo  mokoena"), v("B Two"), v("C Three")]],
    ["sameWallet", [v("A One", T), v("B Two", T), v("C Three")]],
    ["samePerson", [v("A One"), v("a one"), v("C Three")]],
  ] as const)("refuses: %s", (problem, people) => expect(check(...people).problem).toBe(problem));

  it("warns when one is also in the family", () => {
    expect(check(v("Lerato Mokoena"), v("B Two"), v("C Three"))).toEqual({ problem: null, heirs: ["Lerato Mokoena"] });
  });
});

const rule = (id: number, over: Partial<Rule> = {}): Rule => ({
  address: `R${id}`, id, beneficiary: "KID", category: "Books", allowedPayeeKind: "Other", maxPerClaim: 1n, lifetimeCap: 10n, spentTotal: 0n,
  validUntil: 1000, startsNow: true, recurringAmount: 0n, intervalSecs: 0, nextDue: null, fixedPayee: null, ...over,
});

describe("an ended rule's slot (R17)", () => {
  it("only once all 16 are used", () => expect(slotToReuse([rule(0, { validUntil: 1 })], 500)).toBeNull());

  it("then the one that ended first, never a live one", () => {
    const rules = Array.from({ length: 16 }, (_, i) => rule(i, i === 4 ? { validUntil: 300 } : i === 9 ? { validUntil: 200 } : {}));
    expect(slotToReuse(rules, 500)?.id).toBe(9);
    expect(slotToReuse(rules, 100)).toBeNull();
  });
});

describe("what a removal ends (R16)", () => {
  const payee = (wallet: string, kind: Payee["kind"] = "Other"): Payee => ({ address: wallet, wallet, kind, name: wallet });
  const rules = [rule(0), rule(1, { beneficiary: "SIB", recurringAmount: 1n, fixedPayee: "SHOP" }), rule(2, { beneficiary: "SIB" }), rule(3, { validUntil: 1 })];

  it("a person's own live rules", () => {
    expect(rulesEndedByRemoval({ rules, payees: [] }, { beneficiary: "KID" }, 500).map((r) => r.id)).toEqual([0]);
  });

  it("schedules to the payee", () => {
    expect(rulesEndedByRemoval({ rules, payees: [payee("SHOP"), payee("OTHER")] }, { payee: "SHOP" }, 500).map((r) => r.id)).toEqual([1]);
  });

  it("and the rules of a kind when it was the last payee of that kind", () => {
    expect(rulesEndedByRemoval({ rules, payees: [payee("SHOP")] }, { payee: "SHOP" }, 500).map((r) => r.id)).toEqual([0, 1, 2]);
  });
});
