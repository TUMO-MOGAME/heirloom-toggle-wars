import { describe, expect, it } from "vitest";
import { willDraftChecked } from "../agent/schemas";
import { createMockService, DEMO_PERSONAS } from "../service/mock";
import type { WillDraft } from "../types";
import {
  BILL_TEMPLATES, EXECUTOR_DEFAULT_USDT, PER_YEAR, TEMPLATE_KEYS, checkBill, executorCapUsdt, intervalOf, templateForm, toAddRule, toDraftRule,
} from "./templates";

const NOW = Date.parse("2026-11-15T10:00:00+02:00");

describe("bill templates: defaults", () => {
  it("offers the six bills with the rule model's categories and payee kinds", () => {
    expect([...TEMPLATE_KEYS]).toEqual(["funeral", "parent", "medical", "school", "books", "legal"]);
    expect(BILL_TEMPLATES.funeral).toMatchObject({ category: "General", payeeKind: "Other", scheduled: true, every: "month", startsNow: true });
    expect(BILL_TEMPLATES.parent).toMatchObject({ category: "Accommodation", payeeKind: "Landlord", scheduled: true });
    expect(BILL_TEMPLATES.medical).toMatchObject({ category: "Medical", payeeKind: "Other", scheduled: true });
    expect(BILL_TEMPLATES.school).toMatchObject({ category: "Tuition", payeeKind: "School", every: "term" });
    expect(BILL_TEMPLATES.books).toMatchObject({ category: "Books", payeeKind: "Other", every: "month" });
    // Legal and executor fees: after a passing only, claimed against the lawyer's invoice (no schedule).
    expect(BILL_TEMPLATES.legal).toMatchObject({ category: "General", payeeKind: "Other", scheduled: false, startsNow: false });
  });

  it("fills a form whose total covers every payment over the template's years", () => {
    for (const key of TEMPLATE_KEYS) {
      const f = templateForm(key, { now: NOW, beneficiary: "Lerato Mokoena", payee: "Payee" });
      const t = BILL_TEMPLATES[key];
      expect(checkBill(f, NOW), key).toEqual({});
      if (t.scheduled) expect(f.capUsdt, key).toBe(t.amountUsdt * PER_YEAR[t.every] * t.years);
      expect(f.until, key).toBe(`${2026 + t.years}-11-15`);
    }
    expect(templateForm("school", { now: NOW }).capUsdt).toBe(500 * 4 * 4);
  });

  it("caps executor fees at 3.5% of the estate plus 15% VAT, rounded up to 50 USD₮", () => {
    expect(executorCapUsdt(24_000)).toBe(1000); // 24,000 × 3.5% × 1.15 = 966 → 1,000
    expect(executorCapUsdt(100_000)).toBe(4050); // 4,025 → 4,050
    expect(executorCapUsdt(0)).toBe(EXECUTOR_DEFAULT_USDT);
    expect(executorCapUsdt(null)).toBe(EXECUTOR_DEFAULT_USDT);
    expect(executorCapUsdt(500)).toBe(50);
    const legal = templateForm("legal", { now: NOW, estateUsdt: 24_000, beneficiary: "Lerato" });
    expect(legal).toMatchObject({ amountUsdt: 1000, capUsdt: 1000, scheduled: false, payee: "" });
  });
});

describe("bill templates: checks before adding", () => {
  const ok = () => templateForm("funeral", { now: NOW, beneficiary: "Lerato", payee: "Avbob" });
  it("needs someone it is for and, for a schedule, a payee", () => {
    expect(checkBill({ ...ok(), beneficiary: " " }, NOW)).toEqual({ beneficiary: true });
    expect(checkBill({ ...ok(), payee: "" }, NOW)).toEqual({ payee: true });
    // A claim-based bill (legal fees) picks its payee when the invoice comes.
    expect(checkBill(templateForm("legal", { now: NOW, beneficiary: "Lerato" }), NOW)).toEqual({});
  });
  it("refuses zero, negative, huge and non-numbers, and a total below one payment (as the contract does)", () => {
    for (const amountUsdt of [0, -5, Number.NaN, 2_000_000]) expect(checkBill({ ...ok(), amountUsdt }, NOW).amount, String(amountUsdt)).toBe(true);
    expect(checkBill({ ...ok(), capUsdt: 10 }, NOW)).toEqual({ cap: true });
    expect(checkBill({ ...ok(), capUsdt: 25 }, NOW)).toEqual({});
  });
  it("needs an end date after today", () => {
    expect(checkBill({ ...ok(), until: "2026-11-14" }, NOW)).toEqual({ until: true });
    expect(checkBill({ ...ok(), until: "not a date" }, NOW)).toEqual({ until: true });
    expect(checkBill({ ...ok(), until: "2027-01-01" }, NOW)).toEqual({});
  });
});

describe("bill templates: as rules", () => {
  it("becomes a draft rule the will-writer's own checks accept", () => {
    const rule = toDraftRule(templateForm("medical", { now: NOW, beneficiary: "Lerato Mokoena", payee: "Discovery Health" }), "Medical aid");
    expect(rule.recurring).toEqual({ amountUsdt: 150, every: "month", payeeName: "Discovery Health" });
    const legal = toDraftRule(templateForm("legal", { now: NOW, beneficiary: "Lerato Mokoena" }), "Legal and executor fees");
    expect(legal.recurring).toBeUndefined();
    expect(legal.startsNow).toBe(false);
    const draft: WillDraft = {
      ownerName: "Thabo Mokoena", beneficiaries: [{ label: "Lerato Mokoena", relationship: "daughter" }], verifiers: [],
      rules: [rule, legal], assets: [], waitingPeriodDays: 30, plainLanguageSummary: "",
    };
    expect(willDraftChecked.safeParse(draft).success).toBe(true);
  });

  it("becomes addRule input: per payment within the total, first payment one interval away, end of that day in SA", () => {
    const f = templateForm("school", { now: NOW, beneficiary: "WALLET", payee: "SCHOOL" });
    const input = toAddRule(f, { now: NOW, demo: false });
    expect(input.recurring).toEqual({ amountUsdt: 500, intervalSecs: 91 * 86_400, firstDue: NOW / 1000 + 91 * 86_400, payee: "SCHOOL", every: "term" });
    expect(input.maxPerClaimUsdt).toBeLessThanOrEqual(input.lifetimeCapUsdt);
    expect(new Date(input.validUntil * 1000).toISOString()).toBe("2030-11-15T21:59:59.000Z");
    expect(intervalOf("month", true)).toBe(60);
    expect(toAddRule(templateForm("legal", { now: NOW, beneficiary: "W" }), { now: NOW, demo: false }).recurring).toBeUndefined();
  });

  it("adds a signed bill in the demo, and the demo makes up a payee it doesn't know at signing", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const thabo = DEMO_PERSONAS.find((p) => p.key === "thabo")!;
    svc.setActor({ address: thabo.address, role: "owner", label: thabo.label });
    const [{ estate }] = await svc.listEstatesFor(thabo.address);
    let snap = await svc.getEstate(estate);
    const before = snap.rules.length;
    const lerato = snap.beneficiaries[0].wallet;
    const payee = snap.payees.find((p) => p.kind === "Other")!.wallet;
    await svc.addRule(estate, toAddRule(templateForm("funeral", { now: Date.now(), beneficiary: lerato, payee }), { now: Date.now(), demo: true }));
    snap = await svc.getEstate(estate);
    expect(snap.rules).toHaveLength(before + 1);
    expect(snap.rules.at(-1)).toMatchObject({ category: "General", allowedPayeeKind: "Other", startsNow: true, intervalSecs: 60, fixedPayee: payee });

    const fresh = createMockService({ instant: true });
    fresh.resetDemo("fresh");
    fresh.setActor({ address: thabo.address, role: "owner", label: thabo.label });
    const { draft } = await fresh.willChat([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }]);
    draft!.rules.push(toDraftRule(templateForm("funeral", { now: Date.now(), beneficiary: draft!.beneficiaries[0].label, payee: "Avbob Funeral Cover" }), "Funeral cover"));
    // A payee the demo doesn't know: only practice makes it a wallet, as on the chain (plan §18.4 U2).
    await expect(fresh.createEstateFromWill(draft!)).rejects.toThrow(/^recurring_payee/);
    const made = await fresh.createEstateFromWill(draft!, { practice: true });
    const s2 = await fresh.getEstate(made.estate);
    const avbob = s2.payees.find((p) => p.name === "Avbob Funeral Cover");
    expect(avbob?.kind).toBe("Other");
    expect(s2.rules.at(-1)?.fixedPayee).toBe(avbob?.wallet);
  });
});
