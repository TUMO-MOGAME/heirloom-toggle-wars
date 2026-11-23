/** Disputes (U9) and yearly caps in the mock service: the twin of the program's rules, one test per check. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockService, DEMO_PERSONAS } from "./mock";
import { currentPeriod, disputesVotedBy, effectiveStatus, openDisputeOn, yearlyLeft, YEAR_SECS } from "../disputes/types";

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const act = (svc: Svc, key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };
const pdf = (name = "fees.pdf") => new File(["%PDF-1.4 demo"], name, { type: "application/pdf" });
const REASON = "These fees were already paid in March.";

let clock = 1_800_000_000_000;
const advance = (secs: number) => { clock += secs * 1000; vi.setSystemTime(clock); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); clock = 1_800_000_000_000; vi.setSystemTime(clock); });
afterEach(() => { vi.useRealTimers(); });

async function start(stage: "unlocked" | "funded" = "unlocked") {
  const svc = createMockService({ instant: true });
  svc.resetDemo(stage);
  act(svc, "thabo");
  const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
  return { svc, estate, snap: () => svc.getEstate(estate) };
}

/** Lerato's university claim, agent-approved and approved by Adv. Ndlovu (threshold 1): ready to pay. */
async function approvedClaim(svc: Svc, estate: string) {
  svc.simulateSeatApproval(0);
  return (await svc.getEstate(estate)).claims.find((c) => c.status === "Open")!.address;
}

describe("disputes on a claim", () => {
  it("a beneficiary's dispute freezes the payment; two trusted people uphold and it is cancelled", async () => {
    const { svc, estate, snap } = await start();
    const claim = await approvedClaim(svc, estate);
    act(svc, "sipho");
    await svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON });
    const d = (await snap()).disputes![0];
    expect(d).toMatchObject({ kind: "Claim", target: claim, disputer: P("sipho").address, reason: REASON, status: "Open" });
    expect(d.reasonHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(svc.executeClaim(estate, claim)).rejects.toThrow(/^ObjectionOpen/);
    await expect(svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON })).rejects.toThrow(/^ObjectionOpen/);

    await expect(svc.resolveDispute(estate, d.address, true)).rejects.toThrow(/^NotVerifier/);
    act(svc, "nomsa"); await svc.resolveDispute(estate, d.address, true);
    await expect(svc.resolveDispute(estate, d.address, false)).rejects.toThrow(/^AlreadyApproved/);
    act(svc, "david"); await svc.resolveDispute(estate, d.address, true);
    const after = await snap();
    expect(after.disputes![0].status).toBe("Upheld");
    // Inbox → Handled: each voter sees the dispute they decided; the one who raised it (not a voter) doesn't.
    const idx = (k: string) => after.estate.verifiers.indexOf(P(k).address);
    expect(disputesVotedBy(after.disputes, idx("nomsa")).map((x) => x.address)).toEqual([d.address]);
    expect(disputesVotedBy(after.disputes, idx("david")).map((x) => x.address)).toEqual([d.address]);
    expect(disputesVotedBy(after.disputes, -1)).toEqual([]);
    expect(after.claims.find((c) => c.address === claim)!.status).toBe("Rejected");
    await expect(svc.executeClaim(estate, claim)).rejects.toThrow(/^BadStatus/);
  });

  it("dismissed by two: the payment goes ahead, and the claim can't be disputed again", async () => {
    const { svc, estate, snap } = await start();
    const claim = await approvedClaim(svc, estate);
    act(svc, "david"); // a trusted person disputes and then can't decide it
    await svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON });
    const d = (await snap()).disputes![0];
    await expect(svc.resolveDispute(estate, d.address, false)).rejects.toThrow(/^NotVerifier/);
    act(svc, "nomsa"); await svc.resolveDispute(estate, d.address, false);
    act(svc, "busi"); await svc.resolveDispute(estate, d.address, false);
    expect((await snap()).disputes![0].status).toBe("Dismissed");
    act(svc, "sipho");
    await expect(svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON })).rejects.toThrow(/^BadStatus/);
    await svc.executeClaim(estate, claim);
    expect((await snap()).claims.find((c) => c.address === claim)!.status).toBe("Paid");
  });

  it("lapses after the waiting period, so funds are never locked", async () => {
    const { svc, estate, snap } = await start();
    const claim = await approvedClaim(svc, estate);
    act(svc, "sipho");
    await svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON });
    const d = (await snap()).disputes![0];
    act(svc, "nomsa"); await svc.resolveDispute(estate, d.address, true); // one vote, no decision
    advance(59);
    await expect(svc.executeClaim(estate, claim)).rejects.toThrow(/^ObjectionOpen/);
    advance(1);
    expect(effectiveStatus((await snap()).disputes![0], Math.floor(clock / 1000))).toBe("Lapsed");
    act(svc, "david");
    await expect(svc.resolveDispute(estate, d.address, true)).rejects.toThrow(/^DisputeLapsed/);
    await svc.executeClaim(estate, claim);
  });

  it("only family members and trusted people can dispute, with a reason, while the claim is pending", async () => {
    const { svc, estate } = await start();
    const claim = await approvedClaim(svc, estate);
    act(svc, "zanele"); // the car buyer
    await expect(svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON })).rejects.toThrow(/^NotDisputer/);
    act(svc, "sipho");
    await expect(svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: "  " })).rejects.toThrow(/^InvalidAmount/);
    await expect(svc.raiseDispute(estate, { kind: "Unlock", target: estate, reason: REASON })).rejects.toThrow(/^BadStatus/);
    await svc.executeClaim(estate, claim);
    await expect(svc.raiseDispute(estate, { kind: "Claim", target: claim, reason: REASON })).rejects.toThrow(/^BadStatus/);
  });
});

describe("disputes on the unlock", () => {
  it("freezes the waiting period; upheld, the passing report is cancelled", async () => {
    const { svc, estate, snap } = await start("funded");
    svc.simulatePassing();
    expect((await snap()).estate.status).toBe("DeathPending");
    advance(30);
    act(svc, "sipho");
    await svc.raiseDispute(estate, { kind: "Unlock", target: estate, reason: "Dad phoned me this morning." });
    advance(30); // the waiting period is over, the dispute (raised half-way) is not
    await expect(svc.finalizeUnlock(estate)).rejects.toThrow(/^ObjectionOpen/);
    expect(() => svc.skipWait()).toThrow(/^ObjectionOpen/);
    const d = openDisputeOn((await snap()).disputes, estate, Math.floor(clock / 1000))!;
    act(svc, "nomsa"); await svc.resolveDispute(estate, d.address, true);
    act(svc, "busi"); await svc.resolveDispute(estate, d.address, true);
    const e = (await snap()).estate;
    expect(e.status).toBe("Active");
    expect(e.death.certHash).toBeNull();
  });

  it("once per waiting period: dismissed, the unlock goes ahead", async () => {
    const { svc, estate, snap } = await start("funded");
    svc.simulatePassing();
    act(svc, "sipho");
    await svc.raiseDispute(estate, { kind: "Unlock", target: estate, reason: "Dad phoned me this morning." });
    const d = (await snap()).disputes![0];
    act(svc, "nomsa"); await svc.resolveDispute(estate, d.address, false);
    act(svc, "david"); await svc.resolveDispute(estate, d.address, false);
    act(svc, "naledi");
    await expect(svc.raiseDispute(estate, { kind: "Unlock", target: estate, reason: "I disagree too." })).rejects.toThrow(/^BadStatus/);
    advance(60);
    await svc.finalizeUnlock(estate);
    expect((await snap()).estate.status).toBe("Unlocked");
  });

  it("shares the objection's place: a monitor can't object while a dispute is open", async () => {
    const { svc, estate } = await start("funded");
    svc.setupDemoGuardians();
    svc.simulatePassing();
    act(svc, "sipho");
    await svc.raiseDispute(estate, { kind: "Unlock", target: estate, reason: "Dad phoned me this morning." });
    act(svc, "zodwa");
    await expect(svc.raiseObjection(estate, { kind: "Unlock", target: estate, seatIndex: null, reason: "Thabo called me today." })).rejects.toThrow(/^ObjectionOpen/);
  });
});

describe("yearly caps", () => {
  it("the demo seeds Naledi's school fees at 3,000 USD₮ a year", async () => {
    const { snap } = await start();
    const rule = (await snap()).rules.find((r) => r.category === "Tuition" && r.allowedPayeeKind === "School")!;
    expect(rule.yearlyCap).toMatchObject({ cap: 3_000_000_000n, spent: 0n });
  });

  it("limits claims per 12-month period on top of the per-claim and lifetime caps, and resets the next year", async () => {
    const { svc, estate, snap } = await start();
    const rule = (await snap()).rules.find((r) => r.allowedPayeeKind === "School")!;
    const school = (await snap()).payees.find((p) => p.kind === "School")!;
    const pay = async (amountUsdt: number) => {
      act(svc, "naledi");
      const { claim } = await svc.submitClaim(estate, { rule: rule.address, payee: school.wallet, amountUsdt, evidence: pdf() });
      act(svc, "nomsa"); await svc.approveClaim(estate, claim);
      await svc.executeClaim(estate, claim);
    };
    await pay(1500);
    await pay(1500);
    act(svc, "naledi");
    await expect(svc.submitClaim(estate, { rule: rule.address, payee: school.wallet, amountUsdt: 100, evidence: pdf() })).rejects.toThrow(/^ExceedsYearlyCap/);
    const y = (await snap()).rules.find((r) => r.address === rule.address)!.yearlyCap!;
    expect(yearlyLeft(y, Math.floor(clock / 1000))).toBe(0n);
    advance(YEAR_SECS);
    expect(yearlyLeft(y, Math.floor(clock / 1000))).toBe(3_000_000_000n);
    await pay(1000);
    const y2 = (await snap()).rules.find((r) => r.address === rule.address)!.yearlyCap!;
    expect(y2.spent).toBe(1_000_000_000n);
    expect(y2.periodStart).toBe(y.periodStart + YEAR_SECS);
  });

  it("is re-checked when the claim is paid", async () => {
    const { svc, estate, snap } = await start();
    const rule = (await snap()).rules.find((r) => r.allowedPayeeKind === "School")!;
    const school = (await snap()).payees.find((p) => p.kind === "School")!;
    act(svc, "naledi");
    const a = (await svc.submitClaim(estate, { rule: rule.address, payee: school.wallet, amountUsdt: 1500, evidence: pdf() })).claim;
    const b = (await svc.submitClaim(estate, { rule: rule.address, payee: school.wallet, amountUsdt: 1500, evidence: pdf() })).claim;
    const c = (await svc.submitClaim(estate, { rule: rule.address, payee: school.wallet, amountUsdt: 1000, evidence: pdf() })).claim;
    act(svc, "nomsa");
    for (const x of [a, b, c]) await svc.approveClaim(estate, x);
    await svc.executeClaim(estate, a);
    await svc.executeClaim(estate, b);
    await expect(svc.executeClaim(estate, c)).rejects.toThrow(/^ExceedsYearlyCap/);
  });

  it("applies to scheduled payments, and only the owner sets it while the estate is active", async () => {
    const { svc, estate, snap } = await start("funded");
    const books = (await snap()).rules.find((r) => r.category === "Books")!; // 85 USD₮ a month, already paid once
    act(svc, "lerato");
    await expect(svc.setYearlyCap(estate, books.address, { capUsdt: 200 })).rejects.toThrow(/^NotOwner/);
    act(svc, "thabo");
    await expect(svc.setYearlyCap(estate, books.address, { capUsdt: 0 })).rejects.toThrow(/^InvalidAmount/);
    await expect(svc.setYearlyCap(estate, books.address, { capUsdt: 80 })).rejects.toThrow(/^InvalidAmount/); // below one payment
    await expect(svc.setYearlyCap(estate, books.address, { capUsdt: 3001 })).rejects.toThrow(/^InvalidAmount/); // above the total
    await expect(svc.setYearlyCap(estate, books.address, { capUsdt: 200, periodStart: Math.floor(clock / 1000) + 60 })).rejects.toThrow(/^InvalidAmount/);
    await svc.setYearlyCap(estate, books.address, { capUsdt: 170 });
    svc.makeDue(); await svc.executeScheduled(estate, books.address);
    svc.makeDue(); await svc.executeScheduled(estate, books.address);
    svc.makeDue();
    await expect(svc.executeScheduled(estate, books.address)).rejects.toThrow(/^ExceedsYearlyCap/);
    svc.simulatePassing(); svc.skipWait();
    await expect(svc.setYearlyCap(estate, books.address, { capUsdt: 300 })).rejects.toThrow(/^BadStatus/);
  });

  it("currentPeriod rolls forward by whole years", () => {
    expect(currentPeriod(10n, 100, 7n, 100 + YEAR_SECS - 1)).toMatchObject({ periodStart: 100, spent: 7n });
    expect(currentPeriod(10n, 100, 7n, 100 + 2 * YEAR_SECS + 5)).toMatchObject({ periodStart: 100 + 2 * YEAR_SECS, spent: 0n });
  });
});
