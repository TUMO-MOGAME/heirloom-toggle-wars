import { describe, expect, it } from "vitest";
import { createMockService, DEMO_PERSONAS, floorFromText } from "./mock";

describe("floorFromText (mock plan builder)", () => {
  it("uses the latest USD₮ amount, so 'change the minimum' takes effect", () => {
    const text = "Sell my Corolla for no less than 9,000 USDT, unless one of the children is in real need. Change the minimum to 9,500 USDT";
    expect(floorFromText(text)).toBe(9500);
  });
  it("ignores small rand amounts and falls back", () => {
    expect(floorFromText("R1,500 a month for Lerato's books")).toBe(12500);
  });
  it("converts a large rand amount", () => {
    expect(floorFromText("no less than R180 000")).toBeGreaterThan(9000);
  });
});

describe("mock willChat", () => {
  it("updates the car floor when the owner changes it", async () => {
    const svc = createMockService();
    const say = (...t: string[]) => t.map((text) => ({ role: "user" as const, text }));
    const res = await svc.willChat(say("kids", "verifiers", "Sell my Corolla for no less than 9,000 USDT", "Change the minimum to 9,500 USDT"), "en");
    expect(res.draft?.assets[0]?.floorPriceUsdt).toBe(9500);
  });
});

describe("mock hardship (mirrors submit_hardship's one account per family member and car)", () => {
  it("refuses a second request from the same family member after a declined one", async () => {
    const svc = createMockService();
    svc.resetDemo("listed");
    const lerato = DEMO_PERSONAS.find((p) => p.key === "lerato")!;
    svc.setActor({ address: lerato.address, role: lerato.role, label: lerato.label });
    const [{ estate }] = await svc.listEstatesFor(lerato.address);
    const snap = await svc.getEstate(estate);
    const asset = snap!.assets[0].address;
    const pdf = (name: string) => new File(["%PDF-1.4 demo"], name, { type: "application/pdf" });
    const first = await svc.submitHardship(snap!.estate.address, { asset, evidence: pdf("5-hardship-affidavit-unsigned.pdf") });
    expect(first.report.verdict).not.toBe("approve");
    await expect(svc.submitHardship(snap!.estate.address, { asset, evidence: pdf("5-hardship-affidavit-lerato.pdf") }))
      .rejects.toThrow(/already asked once/);
  }, 20_000);
});

describe("mock agent reports carry plain names (no role labels in document data)", () => {
  it("a claim's fee statement names the student without '(daughter)', and a rejected one is not sent on", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const lerato = DEMO_PERSONAS.find((p) => p.key === "lerato")!;
    // The wallet persona's label, as the demo sign-in sets it.
    svc.setActor({ address: lerato.address, role: lerato.role, label: "Lerato Mokoena (daughter)" });
    const [{ estate }] = await svc.listEstatesFor(lerato.address);
    const snap = await svc.getEstate(estate);
    const rule = snap!.rules.find((r) => r.startsNow && r.category === "Tuition")!;
    const payee = snap!.payees.find((p) => p.kind === rule.allowedPayeeKind)!;
    const pdf = (name: string) => new File(["%PDF-1.4 demo"], name, { type: "application/pdf" });
    const ok = await svc.submitClaim(estate, { rule: rule.address, payee: payee.wallet, amountUsdt: 1000, evidence: pdf("fees.pdf") });
    expect(ok.report.extracted["Student"]).toBe("Lerato Mokoena");
    expect(ok.report.summary).not.toMatch(/\(daughter\)/);
    const bad = await svc.submitClaim(estate, { rule: rule.address, payee: payee.wallet, amountUsdt: 1000, evidence: pdf("fee-statement-edited.pdf") });
    expect(bad.report.verdict).toBe("reject");
    expect(bad.report.summary).not.toMatch(/declined this claim/);
    expect(bad.report.summary).toMatch(/clear copy/);
  });
});

describe("M8: two confirms of one payment pay once", () => {
  it("the demo moves the balance once", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const thabo = DEMO_PERSONAS.find((p) => p.key === "thabo")!;
    const lerato = DEMO_PERSONAS.find((p) => p.key === "lerato")!;
    svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
    const before = svc.balanceOf(thabo.address)!;
    const review = await svc.reviewSend({ to: lerato.address, toLabel: "Lerato", amountUsdt: 5 });
    await Promise.all([svc.confirmSend(review), svc.confirmSend(review)]);
    expect(before - svc.balanceOf(thabo.address)!).toBe(5_000_000n);
  });
});
