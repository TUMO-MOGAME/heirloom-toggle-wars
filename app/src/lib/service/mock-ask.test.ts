/** "Ask for money" in the demo: Lerato asks, Thabo approves (paid to her own wallet) or declines; the program's caps hold. */
import { describe, expect, it } from "vitest";
import { createMockService, DEMO_PERSONAS } from "./mock";
import { askStatus } from "../ask/logic";
import { deriveNudges } from "../chat/derive-nudges";
import { toBase } from "../format";

const persona = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;

function demo(stage: "funded" | "unlocked" = "funded") {
  const svc = createMockService({ instant: true });
  svc.resetDemo(stage);
  const act = (key: string) => { const p = persona(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); return p.address; };
  return { svc, act, lerato: persona("lerato").address };
}

async function estateOf(svc: ReturnType<typeof demo>["svc"], wallet: string) {
  const [{ estate }] = await svc.listEstatesFor(wallet);
  return estate;
}

describe("mock Ask for money", () => {
  it("the Mokoena plan has an everyday-needs rule (General, starts now, small caps) with Lerato's own wallet as a payee", async () => {
    const { svc, act, lerato } = demo();
    act("lerato");
    const snap = await svc.getEstate(await estateOf(svc, lerato));
    const rule = snap.rules.find((r) => r.category === "General" && r.beneficiary === lerato)!;
    expect(rule).toMatchObject({ startsNow: true, allowedPayeeKind: "Other", maxPerClaim: toBase(60), lifetimeCap: toBase(720), recurringAmount: BigInt(0) });
    expect(snap.payees.find((p) => p.wallet === lerato)).toMatchObject({ kind: "Other", name: "Lerato's own wallet" });
  });

  it("the funded demo starts with Lerato's field-trip request waiting on Thabo's chat home", async () => {
    const { svc, act, lerato } = demo();
    const owner = act("thabo");
    const snap = await svc.getEstate(await estateOf(svc, owner));
    const claim = snap.claims.find((c) => c.beneficiary === lerato)!;
    expect(snap.asks?.[claim.address]).toMatchObject({ purpose: "Geology field trip to the Cradle of Humankind", currency: "ZAR", typed: 350, attachment: false, declinedAt: null });
    expect(askStatus(claim, snap.estate, snap.asks?.[claim.address])).toBe("waiting");
    const card = deriveNudges(snap, "owner", Math.floor(Date.now() / 1000), { usdtZar: 18.5 }).find((n) => n.id === `claim:${claim.address}`)!;
    expect(card.title).toBe("Lerato asks for money");
    expect(card.body).toContain("Geology field trip to the Cradle of Humankind: ");
    expect(card.body).toContain("R 350");
  });

  it("Lerato asks without a letter; Thabo approves and it is paid to her own wallet", async () => {
    const { svc, act, lerato } = demo();
    act("lerato");
    const estate = await estateOf(svc, lerato);
    let snap = await svc.getEstate(estate);
    const rule = snap.rules.find((r) => r.category === "General" && r.beneficiary === lerato)!;
    const res = await svc.askForMoney(estate, { rule: rule.address, payee: lerato, amountUsdt: 16.22, purpose: "  Taxi to the\nlibrary ", currency: "ZAR", typed: 300 });
    expect(res.report).toMatchObject({ verdict: "needs_human", documentType: "request_note" });
    snap = await svc.getEstate(estate);
    const claim = snap.claims.find((c) => c.address === res.claim)!;
    // The agent had nothing to check, so it refers: it never approves what it could not verify.
    expect(claim).toMatchObject({ status: "Open", agentVerdict: "Referred", amount: toBase(16.22), payee: lerato });
    expect(snap.asks?.[res.claim]).toMatchObject({ purpose: "Taxi to the library", currency: "ZAR", typed: 300, attachment: false });

    act("thabo");
    const before = svc.balanceOf(lerato)!;
    await svc.ownerApproveClaim(estate, res.claim);
    await svc.executeClaim(estate, res.claim);
    snap = await svc.getEstate(estate);
    const paid = snap.claims.find((c) => c.address === res.claim)!;
    expect(askStatus(paid, snap.estate, snap.asks?.[res.claim])).toBe("paid");
    expect(svc.balanceOf(lerato)! - before).toBe(toBase(16.22));
    expect(snap.rules.find((r) => r.address === rule.address)!.spentTotal).toBe(toBase(16.22));
  });

  it("the program's caps refuse an over-limit request with a plain reason", async () => {
    const { svc, act, lerato } = demo();
    act("lerato");
    const estate = await estateOf(svc, lerato);
    const rule = (await svc.getEstate(estate)).rules.find((r) => r.category === "General" && r.beneficiary === lerato)!;
    await expect(svc.askForMoney(estate, { rule: rule.address, payee: lerato, amountUsdt: 60.01, purpose: "Phone", currency: "USDT", typed: 60.01 }))
      .rejects.toMatchObject({ code: "ExceedsPerClaimCap" });
    // Only approved payees of the rule's kind.
    const uct = (await svc.getEstate(estate)).payees.find((p) => p.kind === "University")!;
    await expect(svc.askForMoney(estate, { rule: rule.address, payee: uct.wallet, amountUsdt: 10, purpose: "Books", currency: "USDT", typed: 10 }))
      .rejects.toMatchObject({ code: "WrongPayeeKind" });
    await expect(svc.askForMoney(estate, { rule: rule.address, payee: lerato, amountUsdt: 10, purpose: "   ", currency: "USDT", typed: 10 }))
      .rejects.toMatchObject({ code: "InvalidAmount" });
  });

  it("Thabo declines: Lerato sees it, it can no longer be decided, and only the owner can decline", async () => {
    const { svc, act, lerato } = demo();
    act("lerato");
    const estate = await estateOf(svc, lerato);
    const seeded = (await svc.getEstate(estate)).claims.find((c) => c.beneficiary === lerato)!;
    await expect(svc.declineAsk(estate, seeded.address)).rejects.toMatchObject({ code: "NotOwner" });

    act("thabo");
    await svc.declineAsk(estate, seeded.address);
    await expect(svc.declineAsk(estate, seeded.address)).resolves.toBeUndefined(); // saying no twice is harmless
    let snap = await svc.getEstate(estate);
    expect(askStatus(snap.claims.find((c) => c.address === seeded.address)!, snap.estate, snap.asks?.[seeded.address])).toBe("declined");
    const now = Math.floor(Date.now() / 1000);
    expect(deriveNudges(snap, "owner", now).some((n) => n.id === `claim:${seeded.address}`)).toBe(false);

    act("lerato");
    snap = await svc.getEstate(estate);
    const mine = deriveNudges(snap, "beneficiary", now, { address: lerato }).find((n) => n.id === `ask:${seeded.address}:declined`)!;
    expect(mine.title).toBe("Thabo said no to: Geology field trip to the Cradle of Humankind");
  });

  it("a request already approved cannot be declined", async () => {
    const { svc, act, lerato } = demo();
    const owner = act("thabo");
    const estate = await estateOf(svc, owner);
    const seeded = (await svc.getEstate(estate)).claims.find((c) => c.beneficiary === lerato)!;
    await svc.ownerApproveClaim(estate, seeded.address);
    await expect(svc.declineAsk(estate, seeded.address)).rejects.toMatchObject({ code: "BadStatus" });
  });

  it("a letter the agent cannot accept closes the request", async () => {
    const { svc, act, lerato } = demo();
    act("lerato");
    const estate = await estateOf(svc, lerato);
    const rule = (await svc.getEstate(estate)).rules.find((r) => r.category === "General" && r.beneficiary === lerato)!;
    const letter = new File(["%PDF-1.4 demo"], "school-trip-letter-edited.pdf", { type: "application/pdf" });
    const res = await svc.askForMoney(estate, { rule: rule.address, payee: lerato, amountUsdt: 20, purpose: "School trip", currency: "USDT", typed: 20, evidence: letter });
    expect(res.report.verdict).toBe("reject");
    const snap = await svc.getEstate(estate);
    expect(askStatus(snap.claims.find((c) => c.address === res.claim)!, snap.estate)).toBe("refused");
    expect(snap.asks?.[res.claim]?.attachment).toBe(true);
  });

  it("after Thabo's passing the same request goes to a trusted person, who approves it", async () => {
    const { svc, act, lerato } = demo("unlocked");
    act("lerato");
    const estate = await estateOf(svc, lerato);
    const rule = (await svc.getEstate(estate)).rules.find((r) => r.category === "General" && r.beneficiary === lerato)!;
    const letter = new File(["%PDF-1.4 demo"], "school-trip-letter.pdf", { type: "application/pdf" });
    const res = await svc.askForMoney(estate, { rule: rule.address, payee: lerato, amountUsdt: 25, purpose: "School trip", currency: "USDT", typed: 25, evidence: letter });
    expect(res.report.verdict).toBe("approve");
    act("thabo");
    await expect(svc.declineAsk(estate, res.claim)).rejects.toMatchObject({ code: "BadStatus" });
    const ndlovu = act("nomsa");
    const snap = await svc.getEstate(estate);
    expect(deriveNudges(snap, "verifier", Math.floor(Date.now() / 1000), { address: ndlovu }).some((n) => n.id === `claim:${res.claim}`)).toBe(true);
    await svc.approveClaim(estate, res.claim);
    await svc.executeClaim(estate, res.claim);
    const after = await svc.getEstate(estate);
    expect(after.claims.find((c) => c.address === res.claim)!.status).toBe("Paid");
  });
});
