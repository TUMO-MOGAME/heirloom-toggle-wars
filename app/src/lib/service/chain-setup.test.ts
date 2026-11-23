/** Plan §18.4 U2 and R14: signing never downgrades a schedule, and refuses before the first transaction. */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { checkPeople, planSetup, type SetupInput } from "./chain-setup";
import type { Payee, Rule, WillDraft } from "../types";
import { toBase } from "../format";

const key = () => Keypair.generate().publicKey.toBase58();
const [owner, agent, kid, kid2, v1, v2, v3, res, made] = Array.from({ length: 9 }, key);
const NOW = Math.floor(Date.UTC(2026, 10, 22) / 1000);
const UNTIL = "2031-12-31";

const recurringRule: WillDraft["rules"][number] = {
  beneficiaryLabel: "Child", category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaimUsdt: 300, lifetimeCapUsdt: 9_000,
  validUntil: UNTIL, notes: "", startsNow: true, recurring: { amountUsdt: 300, every: "month", payeeName: "Campus Residence" },
};
const claimRule: WillDraft["rules"][number] = { ...recurringRule, category: "Books", allowedPayeeKind: "School", recurring: undefined };

const draft = (over: Partial<WillDraft> = {}): WillDraft => ({
  ownerName: "Owner", beneficiaries: [{ label: "Child", relationship: "child", wallet: kid }],
  verifiers: [{ name: "One", role: "r", wallet: v1 }, { name: "Two", role: "r", wallet: v2 }, { name: "Three", role: "r", wallet: v3 }],
  rules: [claimRule, recurringRule], assets: [], waitingPeriodDays: 30, plainLanguageSummary: "", ...over,
});

const onChain = (id: number, over: Partial<Rule> = {}): Rule => ({
  address: `R${id}`, id, beneficiary: kid, category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaim: toBase(300),
  lifetimeCap: toBase(9_000), spentTotal: 0n, validUntil: Math.floor(Date.parse(UNTIL) / 1000), startsNow: true,
  recurringAmount: toBase(300), intervalSecs: 2_592_000, nextDue: 1, fixedPayee: res, ...over,
});
const payee = (name = "Campus Residence"): Payee => ({ address: "P", wallet: res, kind: "Landlord", name });

const plan = (over: Partial<SetupInput> = {}) => planSetup({
  draft: draft(), before: null, ruleCount: 0, practice: false, now: NOW, intervalSecs: () => 2_592_000, newWallet: () => made, ...over,
});
const before = (rules: Rule[], payees: Payee[] = [payee()]) => ({ rules, payees, beneficiaries: [] });

describe("U2: a recurring rule is never downgraded", () => {
  it("without its payee signing stops and says what is missing: code recurring_payee", () => {
    expect(() => plan()).toThrowError(expect.objectContaining({
      code: "recurring_payee", message: expect.stringMatching(/^recurring_payee: .*"Campus Residence" \(Landlord\)/),
    }));
  });

  it("names each missing payee once", () => {
    const other = { ...recurringRule, recurring: { ...recurringRule.recurring!, payeeName: "Night School" }, allowedPayeeKind: "School" as const };
    expect(() => plan({ draft: draft({ rules: [recurringRule, recurringRule, other] }) })).toThrow(/Missing: "Campus Residence" \(Landlord\), "Night School" \(School\)\./);
  });

  it("a payee of another kind doesn't serve it", () => {
    expect(() => plan({ before: before([], [{ ...payee(), kind: "Other" }]) })).toThrow(/^recurring_payee/);
  });

  it("with the payee it is a schedule", () => {
    const out = plan({ before: before([]) });
    expect(out.rules[1].recurring).toEqual({ amount: toBase(300), intervalSecs: 2_592_000, firstDue: NOW + 2_592_000, payee: res });
    expect(out.rules[0].recurring).toBeUndefined();
  });

  it("practice mode still makes the payees", () => {
    const out = plan({ practice: true });
    expect(out.payees.map((p) => p.name)).toContain("Campus Residence");
    expect(out.rules[1].recurring!.payee).toBe(made);
  });

  it("a claim rule already on the chain doesn't stand in for the schedule", () => {
    const out = plan({ ruleCount: 1, draft: draft({ rules: [recurringRule] }), before: before([onChain(0, { recurringAmount: 0n, intervalSecs: 0, fixedPayee: null })]) });
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0].recurring).toBeDefined();
  });

  it("nor a schedule of another amount, interval or payee", () => {
    for (const rule of [onChain(0, { recurringAmount: 1n }), onChain(0, { intervalSecs: 60 })]) {
      expect(plan({ ruleCount: 1, draft: draft({ rules: [recurringRule] }), before: before([rule]) }).rules).toHaveLength(1);
    }
    const renamed = { address: "P2", wallet: kid2, kind: "Landlord" as const, name: "Another Residence" };
    const out = plan({ ruleCount: 1, draft: draft({ rules: [recurringRule] }), before: before([onChain(0, { fixedPayee: kid2 })], [payee(), renamed]) });
    expect(out.rules[0].recurring!.payee).toBe(res);
  });

  it("nor the other way round", () => {
    const out = plan({ ruleCount: 1, draft: draft({ rules: [{ ...recurringRule, recurring: undefined }] }), before: before([onChain(0)]) });
    expect(out.rules[0].recurring).toBeUndefined();
  });

  it("signing again adds nothing twice, also when only the role name is known", () => {
    for (const name of ["Campus Residence", "Approved landlord"]) {
      const out = plan({ ruleCount: 1, practice: true, draft: draft({ rules: [recurringRule] }), before: before([onChain(0)], [payee(name)]) });
      expect([out.rules, out.payees]).toEqual([[], []]);
    }
  });

  it.each([
    [0, "InvalidAmount"], [0.000_000_1, "InvalidAmount"], [301, "ExceedsPerClaimCap"],
  ])("a scheduled amount of %s is refused", (amountUsdt, code) => {
    const rules = [{ ...recurringRule, recurring: { ...recurringRule.recurring!, amountUsdt } }];
    expect(() => plan({ draft: draft({ rules }), before: before([]) })).toThrowError(expect.objectContaining({ code }));
  });
});

describe("rules", () => {
  it.each([
    [{ validUntil: "2020-01-01" }, "TimeOutOfRange"], [{ validUntil: "2031-13-45" }, "TimeOutOfRange"],
    [{ maxPerClaimUsdt: 0 }, "InvalidAmount"], [{ lifetimeCapUsdt: 1 }, "InvalidAmount"], [{ beneficiaryLabel: "Nobody" }, "NotBeneficiary"],
  ])("refused before signing: %o", (over, code) => {
    expect(() => plan({ draft: draft({ rules: [{ ...claimRule, ...over }] }) })).toThrowError(expect.objectContaining({ code }));
  });

  it("numbered from the rule count", () => {
    expect(plan({ ruleCount: 3, before: before([]) }).rules.map((r) => r.ruleId)).toEqual([3, 4]);
  });

  it("an ended rule's place is used once the sixteen are full (R17)", () => {
    const rules = Array.from({ length: 16 }, (_, i) => onChain(i, { beneficiary: kid2, validUntil: i === 5 ? NOW - 10 : NOW + 999 }));
    expect(plan({ ruleCount: 16, draft: draft({ rules: [claimRule] }), before: before(rules) }).rules[0].ruleId).toBe(5);
    rules[5].validUntil = NOW + 999;
    expect(() => plan({ ruleCount: 16, draft: draft({ rules: [claimRule] }), before: before(rules) })).toThrow(/^TooManyRules/);
  });

  it("more than sixteen", () => {
    expect(() => plan({ draft: draft({ rules: Array(17).fill(claimRule) }) })).toThrow(/^TooManyRules/);
  });

  it("a removed family member is added back, an active one isn't added twice", () => {
    const ben = (active: boolean) => ({ ...before([]), beneficiaries: [{ address: "B", wallet: kid, label: "Family member 1", active }] });
    expect(plan({ before: ben(false) }).beneficiaries).toHaveLength(1);
    expect(plan({ before: ben(true) }).beneficiaries).toHaveLength(0);
  });
});

describe("people are checked before signing (R14)", () => {
  type People = Pick<WillDraft, "beneficiaries" | "verifiers">;
  const withVerifier = (over: Partial<WillDraft["verifiers"][number]>): People => {
    const d = draft();
    d.verifiers[2] = { ...d.verifiers[2], ...over };
    return d;
  };

  it.each<[string, () => People, string]>([
    ["two trusted people", () => ({ ...draft(), verifiers: draft().verifiers.slice(0, 2) }), "DuplicateVerifier"],
    ["a trusted person with no wallet", () => withVerifier({ wallet: undefined }), "InvalidWallet"],
    ["a trusted person at the empty key", () => withVerifier({ wallet: PublicKey.default.toBase58() }), "InvalidWallet"],
    ["a trusted person with a broken wallet", () => withVerifier({ wallet: "z".repeat(44) }), "InvalidWallet"],
    ["a trusted person with no name", () => withVerifier({ name: "   " }), "InvalidWallet"],
    ["the same trusted person twice", () => withVerifier({ wallet: v1 }), "DuplicateVerifier"],
    ["the owner as a trusted person", () => withVerifier({ wallet: owner }), "DuplicateVerifier"],
    ["the agent as a trusted person", () => withVerifier({ wallet: agent }), "BadAgent"],
    ["the agent as family", () => draft({ beneficiaries: [{ label: "Child", relationship: "", wallet: agent }] }), "BadAgent"],
    ["family with no wallet", () => draft({ beneficiaries: [{ label: "Child", relationship: "" }] }), "InvalidWallet"],
    ["two family members, one wallet", () => draft({ beneficiaries: [{ label: "A", relationship: "", wallet: kid }, { label: "B", relationship: "", wallet: kid }] }), "InvalidWallet"],
    ["two family members, one name", () => draft({ beneficiaries: [{ label: "A", relationship: "", wallet: kid }, { label: "A", relationship: "", wallet: kid2 }] }), "InvalidWallet"],
  ])("%s", (_, people, code) => {
    expect(() => checkPeople(people(), owner, agent)).toThrowError(expect.objectContaining({ code }));
  });

  it("the owner as their own agent", () => {
    expect(() => checkPeople(draft(), owner, owner)).toThrow(/^BadAgent/);
  });

  it("a sound plan passes", () => expect(() => checkPeople(draft(), owner, agent)).not.toThrow());
});
