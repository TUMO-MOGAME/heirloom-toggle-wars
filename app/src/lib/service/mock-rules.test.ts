/**
 * The second security review's rules (plan §18.2 R1-R17 and §18.8 R18-R22) in the mock: the program's twin, with what
 * it allows and what it refuses for each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockService, DEMO_GUARDIANS, DEMO_MINTS, DEMO_PERSONAS, type DemoStage, type MockOptions } from "./mock";
import { MOCK_STORE_KEY } from "./is-mock";
import { NO_WALLET } from "../guardians/decisions";
import { defaultMonitor } from "./chain-guardians";
import { toBase } from "../format";
import type { WillDraft } from "../types";

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const who = (key: string) => P(key).address;
const { kagiso, priya } = DEMO_GUARDIANS;
const NEW = { wallet: "NewTrustedPerson1111111111111111111111111111", name: "Mr. Sizwe Dlamini" };
const NEW_AGENT = "NewAgentWa11et111111111111111111111111111111";
const pdf = (name = "document.pdf") => new File(["%PDF-1.4 demo"], name, { type: "application/pdf" });
const bad = () => pdf("certificate-edited.pdf");

let clock = 0;
const now = () => Math.floor(clock / 1000);
const advance = (secs: number) => { clock += secs * 1000; vi.setSystemTime(clock); };
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); clock = 1_800_000_000_000; vi.setSystemTime(clock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The browser's storage, so a test can open a demo saved in any state (or by an older build). */
function storage() {
  const m = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } });
  return {
    // Plain JSON on purpose: amounts stay as saved ({ $n: "..." }).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    edit(change: (s: any) => void) { const s = JSON.parse(m.get(MOCK_STORE_KEY)!); change(s); m.set(MOCK_STORE_KEY, JSON.stringify(s)); },
  };
}

async function open(svc: Svc) {
  const thabo = P("thabo");
  svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
  const [{ estate }] = await svc.listEstatesFor(thabo.address);
  const act = (key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };
  const be = (address: string, label = "Someone") => svc.setActor({ address, role: "verifier", label });
  const snap = () => svc.getEstate(estate);
  const death = async (by = "lerato", file = pdf()) => { act(by); return svc.submitDeathClaim(estate, file); };
  const attest = async (...keys: string[]) => { for (const k of keys) { act(k); await svc.attestDeath(estate); } };
  /** The passing confirmed and the wait over. */
  const unlock = async () => {
    if (!(await snap()).estate.death.certHash) await death();
    await attest("nomsa", "david");
    advance(60);
    await svc.finalizeUnlock(estate);
    advance(1);
  };
  /** Seat `index` empties: no backups, the agent clears the certificate, another holder confirms, the wait ends. */
  const vacate = async (index: number) => {
    const seat = (await snap()).guardians!.seats[index];
    if (seat.backups.length) { be(seat.holder!); await svc.setSeatBackups(estate, index, []); }
    svc.simulateSeatPassing(index);
    advance(61);
    await svc.finalizeSuccession(estate, index);
  };
  /** Lerato's university claim after the unlock. */
  const claim = async (by = "lerato") => {
    act(by);
    const s = await snap();
    const rule = s.rules.find((r) => r.beneficiary === who(by) && r.category === "Tuition" && r.recurringAmount === 0n)!;
    const payee = s.payees.find((p) => p.kind === rule.allowedPayeeKind)!;
    return (await svc.submitClaim(estate, { rule: rule.address, payee: payee.wallet, amountUsdt: 500, evidence: pdf("fees.pdf") })).claim;
  };
  const theClaim = async (address: string) => (await snap()).claims.find((c) => c.address === address)!;
  return { svc, estate, act, be, snap, death, attest, unlock, vacate, claim, theClaim };
}

async function start(stage: DemoStage = "funded", { guarded = false, opts = {} }: { guarded?: boolean; opts?: MockOptions } = {}) {
  const svc = createMockService({ instant: true, ...opts });
  svc.resetDemo(stage);
  if (guarded) svc.setupDemoGuardians();
  advance(5);
  return open(svc);
}

describe("R1 a check-in during a death claim is proof of life", () => {
  it("clears a claim that was confirmed, so it can never unlock", async () => {
    const t = await start();
    await t.death(); await t.attest("nomsa", "david");
    expect((await t.snap()).estate.status).toBe("DeathPending");
    t.act("thabo"); await t.svc.heartbeat(t.estate);
    const e = (await t.snap()).estate;
    expect(e.status).toBe("Active");
    expect(e.death).toMatchObject({ certHash: null, submittedAt: null, pendingSince: null, attestations: [false, false, false] });
    expect((await t.snap()).activity.map((a) => a.kind)).toContain("DeathVetoed");
    advance(120);
    await expect(t.svc.finalizeUnlock(t.estate)).rejects.toThrow(/^BadStatus/);
  });

  it("a plain check-in only records the time", async () => {
    const t = await start();
    await t.svc.heartbeat(t.estate);
    const s = await t.snap();
    expect(s.estate.lastHeartbeat).toBe(now());
    expect(s.activity[0].kind).toBe("Heartbeat");
  });

  it("only the owner, and not once it has unlocked", async () => {
    const t = await start();
    t.act("lerato");
    await expect(t.svc.heartbeat(t.estate)).rejects.toThrow(/^NotOwner/);
    const done = await start("unlocked");
    await expect(done.svc.heartbeat(done.estate)).rejects.toThrow(/^BadStatus/);
  });

  it("voids an objection to that death", async () => {
    const t = await start("funded", { guarded: true });
    await t.death();
    t.act("zodwa");
    await t.svc.raiseObjection(t.estate, { kind: "Unlock", target: t.estate, seatIndex: null, reason: "He phoned me today." });
    advance(1);
    t.act("thabo"); await t.svc.heartbeat(t.estate);
    const o = (await t.snap()).guardians!.objections[0];
    expect(o.lapsesAt).toBeLessThanOrEqual(now());
    await expect(t.svc.voteObjection(t.estate, o.address, true)).rejects.toThrow(/^ObjectionLapsed/);
  });

  it("voids a dispute of that unlock", async () => {
    const t = await start();
    await t.death(); await t.attest("nomsa", "david");
    t.act("sipho");
    await t.svc.raiseDispute(t.estate, { kind: "Unlock", target: t.estate, reason: "He phoned me today." });
    advance(1);
    t.act("thabo"); await t.svc.heartbeat(t.estate);
    const x = (await t.snap()).disputes![0];
    expect(x.lapsesAt).toBeLessThanOrEqual(now());
    t.act("nomsa");
    await expect(t.svc.resolveDispute(t.estate, x.address, true)).rejects.toThrow(/^DisputeLapsed/);
  });
});

describe("R2 replacing a trusted person is proof of life", () => {
  it("clears the claim the replaced person attested", async () => {
    const t = await start("funded", { guarded: true });
    await t.death(); await t.attest("busi");
    t.act("thabo"); await t.svc.ownerReplaceSeat(t.estate, 2, NEW);
    const e = (await t.snap()).estate;
    expect(e.death.certHash).toBeNull();
    expect(e.lastHeartbeat).toBe(now());
    t.act("busi");
    await expect(t.svc.attestDeath(t.estate)).rejects.toThrow(/^NotVerifier/);
  });

  it("a confirmation by someone since removed clears the report instead of promoting", async () => {
    const t = await start("funded", { guarded: true });
    t.act("zodwa"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("nomsa"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(1);
    t.act("thabo"); await t.svc.ownerReplaceSeat(t.estate, 0, NEW);
    advance(60);
    await t.svc.finalizeSuccession(t.estate, 2);
    const seat = (await t.snap()).guardians!.seats[2];
    expect(seat.succession).toBeNull();
    expect(seat.holder).toBe(who("busi"));
  });

  it("the agent can't be put in a seat", async () => {
    const t = await start("funded", { guarded: true });
    await expect(t.svc.ownerReplaceSeat(t.estate, 2, { wallet: (await t.snap()).estate.agent, name: "Agent" })).rejects.toThrow(/^BadAgent/);
  });
});

describe("R3 trusted people's approvals count only when given after the death", () => {
  it("refuses a trusted person's approval while the estate is Active or waiting", async () => {
    const t = await start();
    const c = await t.claim();
    t.act("nomsa");
    await expect(t.svc.approveClaim(t.estate, c)).rejects.toThrow(/^BadStatus/);
    await t.death(); await t.attest("nomsa", "david");
    await expect(t.svc.approveClaim(t.estate, c)).rejects.toThrow(/^BadStatus/);
  });

  it("approvals saved from before the death neither pay nor block: the same person gives theirs again", async () => {
    const saved = storage();
    const first = await start();
    const c = await first.claim();
    advance(10);
    await first.unlock();
    first.svc.makeDue();
    saved.edit((s) => { s.snap.claims.find((x: { address: string }) => x.address === c).approvals = [true, false, false]; });
    const t = await open(createMockService({ instant: true }));
    expect((await t.theClaim(c)).approvalsCount).toBe(false);
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^InsufficientApprovals/);
    t.act("nomsa"); await t.svc.approveClaim(t.estate, c);
    expect((await t.theClaim(c)).approvalsCount).toBe(true);
    await expect(t.svc.approveClaim(t.estate, c)).rejects.toThrow(/^AlreadyApproved/);
    await t.svc.executeClaim(t.estate, c);
    expect((await t.theClaim(c)).status).toBe("Paid");
  });

  it("a quorum stamped before this death's wait is redone", async () => {
    const saved = storage();
    const first = await start();
    const c = await first.claim();
    const before = now();
    advance(10);
    await first.unlock();
    first.svc.makeDue();
    saved.edit((s) => {
      s.snap.claims.find((x: { address: string }) => x.address === c).approvals = [false, true, false];
      s.guard.stamps[c] = { seatIndex: 1, approver: who("david"), approvedAt: before };
    });
    const t = await open(createMockService({ instant: true }));
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^InsufficientApprovals/);
    t.act("nomsa"); await t.svc.approveClaim(t.estate, c);
    expect((await t.theClaim(c)).approvals).toEqual([true, false, false]);
  });

  it("the owner's approval still pays after the unlock", async () => {
    const t = await start();
    const c = await t.claim();
    t.act("thabo"); await t.svc.ownerApproveClaim(t.estate, c);
    await t.unlock();
    await t.svc.executeClaim(t.estate, c);
    expect((await t.theClaim(c)).status).toBe("Paid");
  });
});

describe("R4 a fallback recipient is only dead when a second person confirms", () => {
  async function reported() {
    const t = await start("guardians");
    t.act("nomsa"); await t.svc.reportFallbackDeath(t.estate, 0, pdf());
    const first = async () => (await t.snap()).guardians!.fallback.recipients[0];
    return { ...t, first };
  }

  it("the agent only sets the verdict", async () => {
    const t = await reported();
    const r = await t.first();
    expect(r.dead).toBe(false);
    expect(r.report).toMatchObject({ verdict: "Approved", reporter: who("nomsa"), reportedAt: now(), confirmableAt: now() + 120 });
  });

  it("a second person confirms, only after the wait", async () => {
    const t = await reported();
    t.act("david");
    advance(119);
    await expect(t.svc.resolveFallbackDeath(t.estate, 0, true)).rejects.toThrow(/^WaitingPeriodNotOver/);
    advance(1);
    await t.svc.resolveFallbackDeath(t.estate, 0, true);
    expect(await t.first()).toMatchObject({ dead: true, report: null });
  });

  it("never the reporter, the person, whoever would be paid instead, or a stranger", async () => {
    const t = await reported();
    advance(120);
    for (const key of ["nomsa", "lerato", "sipho", "zanele"]) {
      t.act(key);
      await expect(t.svc.resolveFallbackDeath(t.estate, 0, true), key).rejects.toThrow(/^NotConfirmer/);
    }
  });

  it("the recipient says \"I'm alive\"; nobody else can say it", async () => {
    const t = await reported();
    t.act("sipho");
    await expect(t.svc.resolveFallbackDeath(t.estate, 0, false)).rejects.toThrow(/^NotParticipant/);
    t.act("lerato"); await t.svc.resolveFallbackDeath(t.estate, 0, false);
    expect(await t.first()).toMatchObject({ dead: false, report: null });
  });

  it("only participants report, and never about themselves", async () => {
    const t = await start("guardians");
    for (const key of ["zanele", "lerato"]) {
      t.act(key);
      await expect(t.svc.reportFallbackDeath(t.estate, 0, pdf()), key).rejects.toThrow(/^NotParticipant/);
    }
    t.act("zodwa"); // a monitor may
    await t.svc.reportFallbackDeath(t.estate, 0, pdf());
  });

  it("reports can't squat: replaced after the hold, the reporter one grace later", async () => {
    const t = await reported();
    t.act("david");
    advance(239);
    await expect(t.svc.reportFallbackDeath(t.estate, 0, pdf())).rejects.toThrow(/^BadStatus/);
    advance(1);
    t.act("nomsa");
    await expect(t.svc.reportFallbackDeath(t.estate, 0, pdf())).rejects.toThrow(/^BadStatus/);
    t.act("david"); await t.svc.reportFallbackDeath(t.estate, 0, pdf());
    expect((await t.first()).report?.reporter).toBe(who("david"));
  });

  it("an unreviewed report can't be confirmed", async () => {
    const t = await start("guardians", { opts: { agent: () => "down" } });
    t.act("nomsa"); await t.svc.reportFallbackDeath(t.estate, 0, pdf());
    advance(120);
    t.act("david");
    await expect(t.svc.resolveFallbackDeath(t.estate, 0, true)).rejects.toThrow(/^AgentNotApproved/);
  });

  it("a report made during the countdown holds the payout, for a bounded time", async () => {
    const t = await start("guardians");
    t.svc.simulateAllSeatsVacant();
    await t.svc.startFallback(t.estate);
    advance(60);
    t.act("sipho"); await t.svc.reportFallbackDeath(t.estate, 0, pdf());
    advance(60);
    await expect(t.svc.executeFallback(t.estate)).rejects.toThrow(/^DeathReportOpen/);
    advance(180);
    await t.svc.executeFallback(t.estate);
    expect((await t.snap()).guardians!.fallback.done).toBe(true);
  });
});

describe("R5 an abandoned death claim can be replaced", () => {
  it("unreviewed: never replaced, so its time stays when this death's first claim was made", async () => {
    const t = await start("funded", { opts: { agent: () => "down" } });
    await t.death("lerato");
    const at = now();
    expect((await t.snap()).estate.death).toMatchObject({ verdict: "Pending", submittedAt: at, pendingSince: null });
    advance(10_000);
    await expect(t.death("sipho")).rejects.toThrow(/^BadStatus: .*hasn't reviewed it/);
    await expect(t.death("lerato")).rejects.toThrow(/^BadStatus/);
    expect((await t.snap()).estate.death).toMatchObject({ submittedBy: who("lerato"), submittedAt: at });
  });

  it("reviewed and approved: another person after two waiting periods, whoever made it one grace later", async () => {
    const t = await start();
    await t.death("lerato");
    advance(119);
    await expect(t.death("sipho")).rejects.toThrow(/^BadStatus/);
    advance(1);
    await expect(t.death("lerato")).rejects.toThrow(/^BadStatus/);
    await t.death("sipho");
    expect((await t.snap()).estate.death.submittedBy).toBe(who("sipho"));
  });

  it("reviewed without a quorum: after two waiting periods", async () => {
    const t = await start();
    await t.death("lerato"); await t.attest("nomsa");
    advance(119);
    await expect(t.death("sipho")).rejects.toThrow(/^BadStatus/);
    advance(1);
    await t.death("sipho");
    expect((await t.snap()).estate.death.attestations).toEqual([false, false, false]);
  });

  it("with nobody left, a reviewed claim stays as the fallback plan's proof", async () => {
    const t = await start("funded", { guarded: true });
    t.svc.simulateAllSeatsVacant();
    advance(10_000);
    await expect(t.death("sipho")).rejects.toThrow(/^BadStatus/);
  });
});

describe("R6 only participants report a trusted person's death", () => {
  it("a stranger is refused", async () => {
    const t = await start("funded", { guarded: true });
    t.act("zanele");
    await expect(t.svc.reportSeatDeath(t.estate, 2, pdf())).rejects.toThrow(/^NotParticipant/);
  });

  it.each(["nomsa", "thabo", "zodwa", "sipho"])("%s may report", async (key) => {
    const t = await start("funded", { guarded: true });
    t.act(key); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    expect((await t.snap()).guardians!.seats[2].succession).toMatchObject({ reportedBy: who(key), reportedAt: now() });
  });

  it("another seat's monitor is not a participant here, a backup of this seat is", async () => {
    const t = await start("funded", { guarded: true });
    t.be(kagiso.wallet); // watches the attorney, is the first backup here
    await expect(t.svc.reportSeatDeath(t.estate, 0, pdf())).rejects.toThrow(/^NotParticipant/);
    await t.svc.reportSeatDeath(t.estate, 2, pdf());
  });

  it("a stale report gives way, a confirmed one never does", async () => {
    const t = await start("funded", { guarded: true });
    t.act("sipho"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("lerato");
    await expect(t.svc.reportSeatDeath(t.estate, 2, pdf())).rejects.toThrow(/^SuccessionPending/);
    advance(359); // reviewed: it stands for the recovery timeout and two waits (6 x 60 s)
    await expect(t.svc.reportSeatDeath(t.estate, 2, pdf())).rejects.toThrow(/^SuccessionPending/);
    advance(1);
    await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("nomsa"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(10_000);
    t.act("sipho");
    await expect(t.svc.reportSeatDeath(t.estate, 2, pdf())).rejects.toThrow(/^SuccessionPending/);
  });

  it("a stale report doesn't block backup changes", async () => {
    const t = await start("funded", { guarded: true });
    t.act("sipho"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("thabo");
    await expect(t.svc.setSeatBackups(t.estate, 2, [priya])).rejects.toThrow(/^SuccessionPending/);
    advance(360);
    await t.svc.setSeatBackups(t.estate, 2, [priya]);
    expect((await t.snap()).guardians!.seats[2].succession).toBeNull();
  });

  it("the agent can't be a backup", async () => {
    const t = await start("funded", { guarded: true });
    await expect(t.svc.setSeatBackups(t.estate, 2, [{ wallet: (await t.snap()).estate.agent, name: "Agent" }])).rejects.toThrow(/^BadBackup/);
  });
});

describe("R7 a referred death with every seat empty", () => {
  it("starts the fallback, with twice the wait", async () => {
    const t = await start("funded", { guarded: true, opts: { agent: () => "unsure" } });
    await t.death();
    t.svc.simulateAllSeatsVacant();
    expect((await t.snap()).estate.death.verdict).toBe("Referred");
    await t.svc.startFallback(t.estate);
    const f = (await t.snap()).guardians!.fallback;
    expect(f.readyAt).toBe(f.startedAt! + 240);
    advance(239);
    await expect(t.svc.executeFallback(t.estate)).rejects.toThrow(/^WaitingPeriodNotOver/);
    advance(1);
    await t.svc.executeFallback(t.estate);
    expect((await t.snap()).estate).toMatchObject({ status: "Unlocked", vaultBalance: 0n });
  });

  it("an unreviewed death does not", async () => {
    const t = await start("funded", { guarded: true, opts: { agent: () => "down" } });
    await t.death();
    t.svc.simulateAllSeatsVacant();
    await expect(t.svc.startFallback(t.estate)).rejects.toThrow(/^FallbackNotReady/);
  });

  it("a countdown from before the owner's sign of life is void", async () => {
    const t = await start("funded", { guarded: true });
    t.svc.simulateAllSeatsVacant();
    await t.svc.startFallback(t.estate);
    advance(5);
    t.act("thabo"); await t.svc.heartbeat(t.estate);
    expect((await t.snap()).guardians!.fallback).toMatchObject({ startedAt: null, canStart: false });
    advance(300);
    await expect(t.svc.executeFallback(t.estate)).rejects.toThrow(/^FallbackNotReady/);
  });
});

describe("R8 the quorum falls to who is left, never to zero", () => {
  it("a survivor who already voted completes the death quorum by signing again", async () => {
    const t = await start("funded", { guarded: true });
    await t.death(); await t.attest("nomsa");
    await t.vacate(1);
    t.act("nomsa");
    await expect(t.svc.attestDeath(t.estate)).rejects.toThrow(/^AlreadyApproved/);
    await t.vacate(2);
    expect((await t.snap()).estate.status).toBe("Active");
    await t.attest("nomsa");
    expect((await t.snap()).estate).toMatchObject({ status: "DeathPending", death: { pendingSince: now() } });
  });

  it("the same for a claim: signing again starts the window", async () => {
    let unsure = false;
    const t = await start("guardians", { opts: { agent: () => (unsure ? "unsure" : null) } });
    unsure = true;
    const c = await t.claim();
    unsure = false;
    t.act("nomsa"); await t.svc.approveClaim(t.estate, c);
    await expect(t.svc.approveClaim(t.estate, c)).rejects.toThrow(/^AlreadyApproved/);
    await t.vacate(1); await t.vacate(2);
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^ObjectionWindowOpen/);
    t.act("nomsa"); await t.svc.approveClaim(t.estate, c);
    expect((await t.snap()).guardians!.claimPayableAt?.[c]).toBe(now() + 60);
    advance(60);
    await t.svc.executeClaim(t.estate, c);
  });

  it("the same for a hardship", async () => {
    const t = await start("guardians");
    const asset = (await t.snap()).assets[0].address;
    t.act("lerato"); await t.svc.submitHardship(t.estate, { asset, evidence: pdf("affidavit.pdf") });
    const h = (await t.snap()).hardships[0].address;
    t.act("nomsa"); await t.svc.approveHardship(t.estate, h);
    await t.vacate(1);
    t.act("nomsa");
    await expect(t.svc.approveHardship(t.estate, h)).rejects.toThrow(/^AlreadyApproved/);
    await t.vacate(2);
    t.act("nomsa"); await t.svc.approveHardship(t.estate, h);
    expect((await t.snap()).hardships[0].status).toBe("Approved");
  });

  it("an empty seat can't vote, so nobody left means no quorum", async () => {
    const t = await start("funded", { guarded: true });
    t.svc.simulateAllSeatsVacant();
    t.be(NO_WALLET);
    await expect(t.svc.attestDeath(t.estate)).rejects.toThrow(/^NotVerifier/);
    expect((await t.snap()).estate.status).toBe("Active");
  });

  it("the vote of a seat that emptied stops counting", async () => {
    const t = await start("funded", { guarded: true });
    await t.death(); await t.attest("david");
    await t.vacate(1);
    await t.attest("nomsa");
    expect((await t.snap()).estate.status).toBe("Active");
    await t.attest("busi");
    expect((await t.snap()).estate.status).toBe("DeathPending");
  });
});

describe("R9 one wallet, one vote across seats", () => {
  it("a monitor of every seat votes once", async () => {
    const t = await start("funded", { guarded: true });
    for (const i of [0, 1, 2]) await t.svc.setSeatMonitors(t.estate, i, [{ wallet: who("zodwa"), name: "Aunt Zodwa" }]);
    t.svc.simulateAllSeatsVacant();
    await t.svc.startFallback(t.estate);
    const target = (await t.snap()).guardians!.address!;
    t.act("naledi");
    await t.svc.raiseObjection(t.estate, { kind: "Fallback", target, seatIndex: null, reason: "Lerato is abroad." });
    const o = (await t.snap()).guardians!.objections[0].address;
    t.act("zodwa"); await t.svc.voteObjection(t.estate, o, false);
    await expect(t.svc.voteObjection(t.estate, o, false)).rejects.toThrow(/^AlreadyApproved/);
    await expect(t.svc.voteObjection(t.estate, o, true)).rejects.toThrow(/^AlreadyApproved/);
    expect((await t.snap()).guardians!.objections[0]).toMatchObject({ status: "Open", votesDismiss: 1 });
  });
});

describe("R10 a succession held back by its only backup", () => {
  it("clears for a fresh report instead of emptying the seat", async () => {
    const t = await start("funded", { guarded: true });
    await t.svc.setSeatBackups(t.estate, 2, [kagiso]);
    t.be(kagiso.wallet, kagiso.name); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("nomsa"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(60);
    await t.svc.finalizeSuccession(t.estate, 2);
    expect((await t.snap()).guardians!.seats[2]).toMatchObject({ succession: null, holder: who("busi"), vacant: false });
    t.act("zodwa"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("nomsa"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(60);
    await t.svc.finalizeSuccession(t.estate, 2);
    expect((await t.snap()).guardians!.seats[2].holder).toBe(kagiso.wallet);
  });

  it("the seat empties only when no backup could ever take it", async () => {
    const t = await start("funded", { guarded: true });
    await t.vacate(0);
    expect((await t.snap()).guardians!.seats[0]).toMatchObject({ vacant: true, holder: null });
  });
});

describe("R11 nobody decides in their own favour", () => {
  async function leratoIsTrusted() {
    const t = await start("funded", { guarded: true });
    await t.svc.ownerReplaceSeat(t.estate, 2, { wallet: who("lerato"), name: "Lerato Mokoena" });
    return t;
  }

  it("a death claim's submitter can't confirm it", async () => {
    const t = await leratoIsTrusted();
    await t.death("lerato");
    await expect(t.svc.attestDeath(t.estate)).rejects.toThrow(/^OwnApproval/);
  });

  it("a claimant can't approve their claim, or a hardship of their own", async () => {
    const t = await leratoIsTrusted();
    await t.unlock();
    const c = await t.claim("lerato");
    await expect(t.svc.approveClaim(t.estate, c)).rejects.toThrow(/^OwnApproval/);
    await t.svc.submitHardship(t.estate, { asset: (await t.snap()).assets[0].address, evidence: pdf("affidavit.pdf") });
    await expect(t.svc.approveHardship(t.estate, (await t.snap()).hardships[0].address)).rejects.toThrow(/^OwnApproval/);
    t.act("nomsa"); await t.svc.approveClaim(t.estate, c);
  });

  it("their seat isn't counted as eligible", async () => {
    const t = await leratoIsTrusted();
    await t.death("lerato"); await t.attest("nomsa");
    await t.vacate(1);
    t.act("nomsa"); await t.svc.attestDeath(t.estate); // one eligible person is left: Adv. Ndlovu
    expect((await t.snap()).estate.status).toBe("DeathPending");
  });

  it("nor dismiss a challenge to their own claim", async () => {
    const t = await leratoIsTrusted();
    await t.unlock();
    const c = await t.claim("lerato");
    t.act("sipho"); await t.svc.raiseDispute(t.estate, { kind: "Claim", target: c, reason: "Already paid in March." });
    const x = (await t.snap()).disputes![0].address;
    t.act("lerato");
    await expect(t.svc.resolveDispute(t.estate, x, false)).rejects.toThrow(/^OwnApproval/);
    await t.svc.resolveDispute(t.estate, x, true); // upholding is allowed
  });

  it("nor use up the one challenge on their own gain", async () => {
    const t = await start();
    await t.death("lerato"); await t.attest("nomsa", "david");
    t.act("lerato");
    await expect(t.svc.raiseDispute(t.estate, { kind: "Unlock", target: t.estate, reason: "Mine to block." })).rejects.toThrow(/^OwnClaimDispute/);

    const f = await start("guardians");
    f.svc.simulateAllSeatsVacant();
    await f.svc.startFallback(f.estate);
    const target = (await f.snap()).guardians!.address!;
    f.act("lerato"); // paid next
    await expect(f.svc.raiseObjection(f.estate, { kind: "Fallback", target, seatIndex: null, reason: "Mine to block." })).rejects.toThrow(/^OwnClaimDispute/);
  });
});

describe("R12 a trusted person co-signs the sale", () => {
  it("with a co-signature it sells", async () => {
    const t = await start("listed");
    const car = (await t.snap()).assets[0].address;
    t.act("david"); await t.svc.acceptBestOffer(t.estate, car);
    expect((await t.snap()).assets[0].status).toBe("Sold");
  });

  it("never the agent alone, or someone who holds no seat", async () => {
    const t = await start("listed");
    const { assets, estate } = await t.snap();
    t.be(estate.agent, "Agent");
    await expect(t.svc.acceptBestOffer(t.estate, assets[0].address)).rejects.toThrow(/^CoSignerRequired/);
    t.act("lerato");
    await expect(t.svc.acceptBestOffer(t.estate, assets[0].address)).rejects.toThrow(/^CoSignerRequired/);
  });

  it("never the buyer", async () => {
    const t = await start("funded", { guarded: true });
    await t.svc.ownerReplaceSeat(t.estate, 2, { wallet: who("zanele"), name: "Pieter van Wyk" });
    await t.unlock();
    const car = (await t.snap()).assets[0].address;
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 7 * 86_400);
    t.act("zanele"); await t.svc.placeOffer(t.estate, car, 13_400);
    advance(60); // past the offer's objection window
    await expect(t.svc.acceptBestOffer(t.estate, car)).rejects.toThrow(/^CoSignerRequired/);
  });

  it("never to the agent", async () => {
    const t = await start();
    await t.svc.setAgent(t.estate, who("zanele"));
    await t.unlock();
    const car = (await t.snap()).assets[0].address;
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 7 * 86_400);
    t.act("zanele"); await t.svc.placeOffer(t.estate, car, 13_400);
    t.act("nomsa");
    // As the chain ranks it: the agent's offer never ranks, so another buyer's wins (or nothing sells).
    expect((await t.svc.rankOffers(car)).ineligible.map((x) => x.reason)).toContain("The agent can't buy from a plan it serves.");
    await t.svc.acceptBestOffer(t.estate, car);
    expect((await t.snap()).activity.find((a) => a.kind === "AssetSold")?.sale?.buyer).not.toBe(who("zanele"));
  });

  it("with nobody left, only after the listing ends", async () => {
    const t = await start("guardians");
    const car = (await t.snap()).assets[0].address;
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 3600);
    t.svc.simulateAllSeatsVacant();
    t.act("lerato");
    await expect(t.svc.acceptBestOffer(t.estate, car)).rejects.toThrow(/^ListingStillOpen/);
    advance(3600);
    await t.svc.acceptBestOffer(t.estate, car);
    expect((await t.snap()).assets[0].status).toBe("Sold");
  });
});

describe("R13 a title nobody can mint again or freeze", () => {
  const asset = { nftMint: "T1t1eMint11111111111111111111111111111111111", title: "Table", floorUsdt: 200, hardshipFloorUsdt: 100, askingUsdt: 250, proceedsTo: "" };

  it.each([["mint", { mint: true }], ["freeze", { freeze: true }]] as const)("refuses a title with a %s authority", async (_n, held) => {
    const t = await start("funded", { opts: { titleAuthorities: { [asset.nftMint]: held } } });
    await expect(t.svc.registerAsset(t.estate, asset)).rejects.toThrow(/^InvalidNft/);
  });

  it("takes one with neither", async () => {
    const t = await start();
    await t.svc.registerAsset(t.estate, asset);
    expect((await t.snap()).assets.at(-1)?.nftMint).toBe(asset.nftMint);
  });
});

describe("R14 setup takes only values that work", () => {
  async function fresh() {
    const svc = createMockService({ instant: true });
    svc.resetDemo("fresh");
    const thabo = P("thabo");
    svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
    const { draft } = await svc.willChat(["a", "b", "c"].map((text) => ({ role: "user" as const, text })), "en");
    return { svc, draft: draft! };
  }
  const withWallet = (d: WillDraft, i: number, wallet: string): WillDraft => ({ ...d, verifiers: d.verifiers.map((v, j) => (j === i ? { ...v, wallet } : v)) });

  it("three real, different trusted people who are not the owner", async () => {
    const { svc, draft } = await fresh();
    await expect(svc.createEstateFromWill({ ...draft, verifiers: draft.verifiers.slice(0, 2) })).rejects.toThrow(/^InvalidWallet/);
    await expect(svc.createEstateFromWill(withWallet(draft, 1, NO_WALLET))).rejects.toThrow(/^InvalidWallet/);
    await expect(svc.createEstateFromWill(withWallet(draft, 1, who("thabo")))).rejects.toThrow(/^DuplicateVerifier/);
    await expect(svc.createEstateFromWill(withWallet(draft, 1, who("nomsa")))).rejects.toThrow(/^DuplicateVerifier/);
    await svc.createEstateFromWill(draft); // a refusal changed nothing, so the good plan still signs
  });

  it("a real agent who is neither the owner nor trusted", async () => {
    const { svc, draft } = await fresh();
    const agent = "AgNt1HeiRLooMwDKagentWaLLet7xQp5sZc3FdYg8uE6r";
    await expect(svc.createEstateFromWill(withWallet(draft, 0, agent))).rejects.toThrow(/^BadAgent/);
  });

  it("an end date in the future, when signing and when adding a rule", async () => {
    const { svc, draft } = await fresh();
    await expect(svc.createEstateFromWill({ ...draft, rules: [{ ...draft.rules[1], validUntil: "2020-01-01" }] })).rejects.toThrow(/^TimeOutOfRange/);
    const t = await start();
    const r = { beneficiary: who("lerato"), category: "Books" as const, allowedPayeeKind: "Other" as const, maxPerClaimUsdt: 10, lifetimeCapUsdt: 100, startsNow: true };
    await expect(t.svc.addRule(t.estate, { ...r, validUntil: now() })).rejects.toThrow(/^TimeOutOfRange/);
    await t.svc.addRule(t.estate, { ...r, validUntil: now() + 1 });
  });

  it("a real proceeds wallet, or the vault", async () => {
    const t = await start();
    const asset = { nftMint: "Tab1eMint11111111111111111111111111111111111", title: "Table", floorUsdt: 200, hardshipFloorUsdt: 100, askingUsdt: 250, proceedsTo: NO_WALLET };
    await expect(t.svc.registerAsset(t.estate, asset)).rejects.toThrow(/^InvalidWallet/);
    await t.svc.registerAsset(t.estate, { ...asset, proceedsTo: t.estate });
    expect((await t.snap()).assets.at(-1)?.proceedsTo).toBe(t.estate);
  });

  it("signing never downgrades a schedule without a payee (U2)", async () => {
    const { svc, draft } = await fresh();
    const rules = [{ ...draft.rules[0], recurring: { ...draft.rules[0].recurring!, payeeName: "A shop nobody added" } }];
    await expect(svc.createEstateFromWill({ ...draft, rules }, { practice: false })).rejects.toThrow(/^recurring_payee/);
    const { estate } = await svc.createEstateFromWill({ ...draft, rules }, { practice: true });
    expect((await svc.getEstate(estate)).rules[0].recurringAmount).toBe(toBase(85));
  });
});

describe("R15 the living owner takes an asset back", () => {
  it("removes it, and its photos are found again when it is registered again", async () => {
    const t = await start();
    const car = (await t.snap()).assets.find((a) => a.nftMint === DEMO_MINTS.car)!;
    await t.svc.releaseAsset(t.estate, car.address);
    expect((await t.snap()).assets.map((a) => a.address)).not.toContain(car.address);
    await t.svc.registerAsset(t.estate, { nftMint: car.nftMint, title: "Corolla", floorUsdt: 12_000, hardshipFloorUsdt: 10_000, askingUsdt: 13_000, proceedsTo: "" });
    expect((await t.snap()).assets.at(-1)?.address).toBe(car.address);
  });

  it("only the owner, only while Active", async () => {
    const t = await start();
    const car = (await t.snap()).assets[0].address;
    t.act("lerato");
    await expect(t.svc.releaseAsset(t.estate, car)).rejects.toThrow(/^NotOwner/);
    const done = await start("listed");
    await expect(done.svc.releaseAsset(done.estate, (await done.snap()).assets[0].address)).rejects.toThrow(/^BadStatus/);
  });
});

describe("R16 removing a beneficiary or a payee", () => {
  it("ends the rules only they could use, moves the residual and clears a death claim", async () => {
    const t = await start();
    const c = await t.claim("lerato");
    await t.death("sipho");
    t.act("thabo");
    await expect(t.svc.removeMember(t.estate, { beneficiary: who("lerato") })).rejects.toThrow(/^residual/);
    await t.svc.removeMember(t.estate, { beneficiary: who("lerato"), newResidual: who("sipho") });
    const s = await t.snap();
    expect(s.beneficiaries.find((b) => b.wallet === who("lerato"))?.active).toBe(false);
    expect(s.residual).toBe(who("sipho"));
    expect(s.estate.death.certHash).toBeNull();
    for (const r of s.rules) expect(r.validUntil < now(), r.category).toBe(r.beneficiary === who("lerato"));
    await t.svc.ownerApproveClaim(t.estate, c);
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^NotBeneficiary/);
    await expect(t.claim("lerato")).rejects.toThrow(/^NotBeneficiary/);
    await expect(t.death("lerato")).rejects.toThrow(/^NotBeneficiary/);
  });

  it("a removed payee is paid nothing more", async () => {
    const t = await start();
    const c = await t.claim("lerato");
    const before = await t.snap();
    const payee = before.claims.find((x) => x.address === c)!.payee;
    t.act("thabo");
    await t.svc.ownerApproveClaim(t.estate, c);
    await t.svc.removeMember(t.estate, { payee });
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^AccountNotInitialized/);
    // Another university is still approved, so the tuition rules stay.
    const s = await t.snap();
    expect(s.rules.filter((r) => r.allowedPayeeKind === "University").every((r) => r.validUntil > now())).toBe(true);
  });

  it("a schedule to a removed payee stops and its rule ends", async () => {
    const t = await start();
    const r = (await t.snap()).rules.find((x) => x.startsNow && x.recurringAmount > 0n && x.category === "Books")!;
    await t.svc.removeMember(t.estate, { payee: r.fixedPayee! });
    t.svc.makeDue();
    await expect(t.svc.executeScheduled(t.estate, r.address)).rejects.toThrow(/^AccountNotInitialized/);
    expect((await t.snap()).rules.find((x) => x.address === r.address)!.validUntil).toBeLessThan(now());
  });

  it("only the owner, only while Active, and only someone who is there", async () => {
    const t = await start();
    await expect(t.svc.removeMember(t.estate, {})).rejects.toThrow(/^BadStatus/);
    await expect(t.svc.removeMember(t.estate, { beneficiary: who("zanele") })).rejects.toThrow(/^NotBeneficiary/);
    t.act("lerato");
    await expect(t.svc.removeMember(t.estate, { beneficiary: who("sipho") })).rejects.toThrow(/^NotOwner/);
    const done = await start("unlocked");
    await expect(done.svc.removeMember(done.estate, { beneficiary: who("sipho") })).rejects.toThrow(/^BadStatus/);
  });
});

describe("R17 an ended rule's slot", () => {
  const rule = (extra: object = {}) => ({
    beneficiary: who("lerato"), category: "Books" as const, allowedPayeeKind: "Other" as const,
    maxPerClaimUsdt: 10, lifetimeCapUsdt: 100, startsNow: true, validUntil: now() + 999, ...extra,
  });

  it("is reused without reviving an old claim or keeping what was spent", async () => {
    const t = await start();
    const c = await t.claim();
    const before = await t.snap();
    const used = before.claims.find((x) => x.address === c)!.rule;
    const old = before.rules.find((r) => r.address === used)!;
    t.act("thabo");
    await t.svc.setYearlyCap(t.estate, old.address, { capUsdt: 3000 });
    await t.svc.endRule(t.estate, old.address);
    await t.svc.addRule(t.estate, rule({ reuse: old.address }));
    const s = await t.snap();
    const next = s.rules.find((r) => r.address === old.address)!;
    expect(next).toMatchObject({ id: old.id, category: "Books", spentTotal: 0n, claimCount: 65_536 });
    expect(next.yearlyCap ?? null).toBeNull();
    expect(s.rules).toHaveLength(before.rules.length);
    expect((await t.theClaim(c)).fromEndedRule).toBe(true);
    await expect(t.svc.ownerApproveClaim(t.estate, c)).rejects.toThrow(/^ClaimFromEndedRule/);
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^ClaimFromEndedRule/);
  });

  it("the new rule's own claims pay", async () => {
    const t = await start();
    const s = await t.snap();
    const old = s.rules.find((r) => r.category === "General" && r.startsNow && r.recurringAmount === 0n)!;
    await t.svc.endRule(t.estate, old.address);
    await t.svc.addRule(t.estate, rule({ reuse: old.address }));
    t.act("lerato");
    const { claim } = await t.svc.submitClaim(t.estate, { rule: old.address, payee: who("lerato"), amountUsdt: 5, evidence: pdf("note.pdf") });
    expect((await t.theClaim(claim)).id).toBe(65_536);
    t.act("thabo");
    await t.svc.ownerApproveClaim(t.estate, claim);
    await t.svc.executeClaim(t.estate, claim);
  });

  it("never a live rule's", async () => {
    const t = await start();
    await expect(t.svc.addRule(t.estate, rule({ reuse: (await t.snap()).rules[0].address }))).rejects.toThrow(/^BadStatus/);
  });

  it("frees a place when all 16 are used", async () => {
    const t = await start();
    while ((await t.snap()).rules.length < 16) await t.svc.addRule(t.estate, rule());
    await expect(t.svc.addRule(t.estate, rule())).rejects.toThrow(/^TooManyRules/);
    const last = (await t.snap()).rules[15].address;
    await t.svc.endRule(t.estate, last);
    await t.svc.addRule(t.estate, rule({ reuse: last }));
    expect((await t.snap()).rules).toHaveLength(16);
  });
});

describe("R18 the last holder that nobody watches", () => {
  async function lastHolder() {
    const t = await start("funded", { guarded: true });
    await t.vacate(0); await t.vacate(1);
    t.act("thabo");
    await t.svc.setSeatBackups(t.estate, 2, [kagiso]);
    await t.svc.setSeatMonitors(t.estate, 2, []);
    t.act("sipho"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    return t;
  }

  it("a family member confirms and the backup takes the seat", async () => {
    const t = await lastHolder();
    t.act("lerato"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(60);
    await t.svc.finalizeSuccession(t.estate, 2);
    expect((await t.snap()).guardians!.seats[2].holder).toBe(kagiso.wallet);
  });

  it("giving the seat a monitor clears the family's confirmation", async () => {
    const t = await lastHolder();
    t.act("lerato"); await t.svc.confirmSeatDeath(t.estate, 2);
    t.act("thabo"); await t.svc.setSeatMonitors(t.estate, 2, [{ wallet: who("zodwa"), name: "Aunt Zodwa" }]);
    expect((await t.snap()).guardians!.seats[2].succession).toBeNull();
    await expect(t.svc.finalizeSuccession(t.estate, 2)).rejects.toThrow(/^NoSuccessionPending/);
  });

  it("an empty monitor list, or a confirmation by another holder, clears nothing", async () => {
    const t = await lastHolder();
    t.act("lerato"); await t.svc.confirmSeatDeath(t.estate, 2);
    t.act("thabo"); await t.svc.setSeatMonitors(t.estate, 2, []);
    expect((await t.snap()).guardians!.seats[2].succession?.confirmedBy).toBe(who("lerato"));

    const h = await start("funded", { guarded: true });
    h.act("zodwa"); await h.svc.reportSeatDeath(h.estate, 2, pdf());
    h.act("nomsa"); await h.svc.confirmSeatDeath(h.estate, 2);
    h.act("thabo"); await h.svc.setSeatMonitors(h.estate, 2, [priya]);
    expect((await h.snap()).guardians!.seats[2].succession?.confirmedBy).toBe(who("nomsa"));
  });

  it("the confirmation stands after a check-in while that person stays in the plan", async () => {
    const t = await lastHolder();
    t.act("lerato"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(1);
    t.act("thabo"); await t.svc.heartbeat(t.estate);
    advance(60);
    await t.svc.finalizeSuccession(t.estate, 2);
    expect((await t.snap()).guardians!.seats[2].holder).toBe(kagiso.wallet);
  });

  it("and is cleared when the owner has since removed them", async () => {
    const t = await lastHolder();
    t.act("lerato"); await t.svc.confirmSeatDeath(t.estate, 2);
    advance(1);
    t.act("thabo"); await t.svc.removeMember(t.estate, { beneficiary: who("lerato"), newResidual: who("sipho") });
    advance(60);
    await t.svc.finalizeSuccession(t.estate, 2);
    expect((await t.snap()).guardians!.seats[2]).toMatchObject({ holder: who("busi"), succession: null });
  });

  it("not whoever reported it, the next holder or a stranger", async () => {
    const t = await lastHolder();
    for (const w of [who("sipho"), kagiso.wallet, who("zanele")]) {
      t.be(w);
      await expect(t.svc.confirmSeatDeath(t.estate, 2)).rejects.toThrow(/^NotConfirmer/);
    }
  });

  it("no family route while a monitor or another holder can confirm", async () => {
    const t = await start("funded", { guarded: true });
    t.act("sipho"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    t.act("lerato");
    await expect(t.svc.confirmSeatDeath(t.estate, 2)).rejects.toThrow(/^NotConfirmer/);
    await t.vacate(0); await t.vacate(1);
    t.act("lerato");
    await expect(t.svc.confirmSeatDeath(t.estate, 2)).rejects.toThrow(/^NotConfirmer/);
  });
});

describe("R19 the co-signature is for an exact amount", () => {
  it("signs what was shown", async () => {
    const t = await start("listed");
    const car = (await t.snap()).assets[0].address;
    const best = (await t.svc.rankOffers(car)).eligible[0];
    t.act("nomsa");
    await t.svc.acceptBestOffer(t.estate, car, { offer: best.offer, amount: best.amount, recipient: t.estate });
  });

  it("H11: refuses when who gets the money changed after it was shown", async () => {
    const t = await start("listed");
    const car = (await t.snap()).assets[0].address;
    const best = (await t.svc.rankOffers(car)).eligible[0];
    t.act("nomsa");
    await expect(t.svc.acceptBestOffer(t.estate, car, { offer: best.offer, amount: best.amount, recipient: who("lerato") })).rejects.toThrow(/^OfferChanged/);
  });

  it("refuses when the offer changed after it was shown", async () => {
    const t = await start("listed");
    const car = (await t.snap()).assets[0].address;
    const best = (await t.svc.rankOffers(car)).eligible[0];
    t.act("nomsa");
    await expect(t.svc.acceptBestOffer(t.estate, car, { offer: best.offer, amount: best.amount + 1n, recipient: t.estate })).rejects.toThrow(/^OfferChanged/);
    t.act("zanele"); await t.svc.placeOffer(t.estate, car, 13_400);
    t.act("nomsa");
    await expect(t.svc.acceptBestOffer(t.estate, car, { offer: best.offer, amount: best.amount, recipient: t.estate })).rejects.toThrow(/^OfferChanged/);
    expect((await t.snap()).assets[0].status).toBe("Listed");
  });
});

describe("R20 a sweep and a reported death", () => {
  async function surplus(named: boolean) {
    const saved = storage();
    const first = await start("guardians");
    first.svc.makeDue();
    saved.edit((s) => {
      if (!named) s.snap.residual = null;
      s.snap.estate.vaultBalance = { $n: toBase(500_000).toString() };
    });
    const t = await open(createMockService({ instant: true }));
    t.act("nomsa"); await t.svc.reportFallbackDeath(t.estate, 0, pdf());
    return t;
  }

  it("holds a payment by the fallback list, for a bounded time", async () => {
    const t = await surplus(false);
    expect((await t.snap()).residual).toBe(who("lerato"));
    await expect(t.svc.sweepResidual(t.estate)).rejects.toThrow(/^DeathReportOpen/);
    advance(120);
    await expect(t.svc.sweepResidual(t.estate)).rejects.toThrow(/^DeathReportOpen/);
    advance(120);
    await t.svc.sweepResidual(t.estate);
  });

  it("pays the next person once the death is confirmed", async () => {
    const t = await surplus(false);
    advance(120);
    t.act("david"); await t.svc.resolveFallbackDeath(t.estate, 0, true);
    const before = t.svc.balanceOf(who("sipho"))!;
    await t.svc.sweepResidual(t.estate);
    expect(t.svc.balanceOf(who("sipho"))!).toBeGreaterThan(before);
  });

  it("doesn't hold a payment to someone the owner named", async () => {
    const t = await surplus(true);
    await t.svc.sweepResidual(t.estate);
  });
});

describe("R21 one approved hardship", () => {
  async function two() {
    const t = await start("listed");
    const asset = (await t.snap()).assets[0].address;
    for (const key of ["lerato", "sipho"]) { t.act(key); await t.svc.submitHardship(t.estate, { asset, evidence: pdf("affidavit.pdf") }); }
    const [second, first] = (await t.snap()).hardships;
    for (const key of ["nomsa", "david"]) { t.act(key); await t.svc.approveHardship(t.estate, first.address); }
    return { ...t, second };
  }

  it("the first stands, and a second can't replace its recipient", async () => {
    const t = await two();
    t.act("busi");
    await expect(t.svc.approveHardship(t.estate, t.second.address)).rejects.toThrow(/^BadStatus/);
    const s = await t.snap();
    expect(s.assets[0].hardshipBeneficiary).toBe(who("lerato"));
    expect(s.hardships[0].approvals).toEqual([false, false, false]);
  });

  it("an upheld objection to the first frees it", async () => {
    const saved = storage();
    const first = await two();
    first.svc.makeDue();
    saved.edit((s) => {
      s.snap.hardships[1].status = "Rejected";
      s.snap.assets[0].hardshipBeneficiary = null;
    });
    const t = await open(createMockService({ instant: true }));
    for (const key of ["nomsa", "david"]) { t.act(key); await t.svc.approveHardship(t.estate, first.second.address); }
    expect((await t.snap()).assets[0].hardshipBeneficiary).toBe(who("sipho"));
  });
});

describe("R22 only the living owner changes what buyers see", () => {
  it("the owner can", async () => {
    const t = await start();
    await t.svc.setAssetMedia(t.estate, (await t.snap()).assets[0].address, { kind: "Car", title: "Corolla", photos: [] });
  });

  it("nobody changes photos after the unlock, the agent included", async () => {
    const t = await start("unlocked");
    const s = await t.snap();
    t.be(s.estate.agent, "Agent");
    await expect(t.svc.setAssetMedia(t.estate, s.assets[0].address, { kind: "Car", title: "x", photos: [] })).rejects.toThrow(/^NotOwner/);
  });

  it("not the agent, and not the owner after the passing", async () => {
    const t = await start();
    const s = await t.snap();
    const media = { kind: "Car" as const, title: "x", photos: [] };
    t.be(s.estate.agent, "Agent");
    await expect(t.svc.setAssetMedia(t.estate, s.assets[0].address, media)).rejects.toThrow(/^NotOwner/);
    const done = await start("unlocked");
    await expect(done.svc.setAssetMedia(done.estate, (await done.snap()).assets[0].address, media)).rejects.toThrow(/^NotOwner/);
  });
});

describe("replacing the agent", () => {
  it("the owner does it alone, which clears a death claim", async () => {
    const t = await start();
    await t.death();
    t.act("thabo"); await t.svc.setAgent(t.estate, NEW_AGENT);
    const e = (await t.snap()).estate;
    expect(e.agent).toBe(NEW_AGENT);
    expect(e.death.certHash).toBeNull();
  });

  it("not to the owner, a trusted person, the same agent or nobody; and nobody else", async () => {
    const t = await start();
    for (const w of [who("thabo"), who("nomsa"), (await t.snap()).estate.agent, NO_WALLET]) {
      await expect(t.svc.setAgent(t.estate, w)).rejects.toThrow(/^BadAgent/);
    }
    t.act("lerato");
    await expect(t.svc.setAgent(t.estate, NEW_AGENT)).rejects.toThrow(/^NotOwner/);
    await expect(t.svc.voteAgent(t.estate, NEW_AGENT)).rejects.toThrow(/^NotVerifier/);
  });

  it("while Active it takes every trusted person", async () => {
    const t = await start();
    t.act("nomsa"); await t.svc.voteAgent(t.estate, NEW_AGENT);
    await expect(t.svc.voteAgent(t.estate, NEW_AGENT)).rejects.toThrow(/^AlreadyApproved/);
    t.act("david"); await t.svc.voteAgent(t.estate, NEW_AGENT);
    expect((await t.snap()).agentVotes).toEqual([{ candidate: NEW_AGENT, voters: [who("nomsa"), who("david")] }]);
    t.act("busi"); await t.svc.voteAgent(t.estate, NEW_AGENT);
    expect(await t.snap()).toMatchObject({ estate: { agent: NEW_AGENT }, agentVotes: [] });
  });

  it("afterwards two", async () => {
    const t = await start("unlocked");
    for (const key of ["nomsa", "david"]) { t.act(key); await t.svc.voteAgent(t.estate, NEW_AGENT); }
    expect((await t.snap()).estate.agent).toBe(NEW_AGENT);
  });
});

describe("a demo saved by an older build", () => {
  it("heals: a claim with no time is stale, claim ids carry on, and nothing crashes", async () => {
    const saved = storage();
    const first = await start("funded", { guarded: true });
    await first.death("lerato");
    first.svc.makeDue();
    saved.edit((s) => {
      delete s.snap.estate.death.submittedAt;
      delete s.guard.fallbackReports;
      for (const r of s.snap.rules) delete r.claimCount;
    });
    const t = await open(createMockService({ instant: true }));
    const s = await t.snap();
    expect(s.estate.death.submittedAt).toBe(0);
    expect(s.guardians!.fallback.recipients[0].report).toBeNull();
    const asked = s.claims[0];
    expect(s.rules.find((r) => r.address === asked.rule)!.claimCount).toBe(asked.id + 1);
    expect(asked.fromEndedRule).toBe(false);
    await t.death("sipho"); // stale at once
  });

  it("an unreadable one starts again instead of crashing", async () => {
    const saved = storage();
    (await start()).svc.makeDue();
    saved.edit((s) => { delete s.snap.rules; });
    const svc = createMockService({ instant: true });
    expect(await svc.listEstatesFor(who("thabo"))).toEqual([]);
  });

  it("a rejected certificate leaves no claim", async () => {
    const t = await start();
    const { report } = await t.death("lerato", bad());
    expect(report.verdict).toBe("reject");
    expect((await t.snap()).estate.death.certHash).toBeNull();
  });
});

describe("the same as the chain service", () => {
  it("no practice answer is not practice: a schedule without its payee refuses", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("fresh");
    const p = P("thabo");
    svc.setActor({ address: p.address, role: p.role, label: p.label });
    const { draft } = await svc.willChat([{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }] as never);
    const rules = draft!.rules.map((r) => (r.recurring ? { ...r, recurring: { ...r.recurring, payeeName: "A payee nobody knows" } } : r));
    await expect(svc.createEstateFromWill({ ...draft!, rules })).rejects.toThrow(/^recurring_payee/);
    await svc.createEstateFromWill({ ...draft!, rules }, { practice: true });
  });

  it("a removal names the new recipient, removes, then ends the rules", async () => {
    const t = await start("funded", { guarded: true });
    const before = (await t.snap()).activity.length;
    const newResidual = who("sipho");
    t.act("thabo");
    await expect(t.svc.removeMember(t.estate, { beneficiary: who("lerato") })).rejects.toThrow(/^residual/);
    await t.svc.removeMember(t.estate, { beneficiary: who("lerato"), newResidual });
    const s = await t.snap();
    const kinds = s.activity.slice(0, s.activity.length - before).map((a) => a.kind).reverse()
      .filter((k) => ["ResidualSet", "MemberRemoved", "RuleEnded"].includes(k));
    expect([...new Set(kinds)]).toEqual(["ResidualSet", "MemberRemoved", "RuleEnded"]);
    expect(kinds.lastIndexOf("MemberRemoved")).toBeLessThan(kinds.indexOf("RuleEnded"));
    expect(s.residual).toBe(newResidual);
    expect(s.beneficiaries.find((b) => b.wallet === who("lerato"))).toMatchObject({ active: false });
    await expect(t.svc.removeMember(t.estate, { beneficiary: who("lerato") })).rejects.toThrow(/^BadStatus/);
  });

  it("never hands what is left to someone already removed", async () => {
    const t = await start();
    t.act("thabo");
    await t.svc.removeMember(t.estate, { beneficiary: who("sipho") });
    await expect(t.svc.removeMember(t.estate, { beneficiary: who("lerato"), newResidual: who("sipho") })).rejects.toThrow(/^residual/);
  });

  it("a seat made without a monitor gets the chain's: one from the active family", async () => {
    const t = await start();
    t.act("thabo");
    await t.svc.setupGuardians(t.estate, { seats: [0, 1, 2].map((index) => ({ index, backups: [], monitors: index === 1 ? [{ wallet: who("zodwa"), name: "Aunt Zodwa" }] : [] })), fallback: [] });
    const s = await t.snap();
    const family = s.beneficiaries.filter((b) => b.active).sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true })).map((b) => b.wallet);
    for (const i of [0, 2]) {
      const expected = defaultMonitor(i, { holder: s.estate.verifiers[i], backups: [], family, verifiers: [...s.estate.verifiers], owner: s.estate.owner });
      expect(s.guardians!.seats[i].monitors.map((m) => m.wallet)).toEqual([expected]);
    }
    expect(s.guardians!.seats[1].monitors.map((m) => m.wallet)).toEqual([who("zodwa")]);
    await t.svc.setSeatMonitors(t.estate, 0, []);
    expect((await t.snap()).guardians!.seats[0].monitors).toEqual([]);
  });

  it("with every seat empty the family may have a held asset listed; not while someone holds a seat", async () => {
    const t = await start("guardians");
    const car = (await t.snap()).assets[0].address;
    t.act("lerato");
    await expect(t.svc.listAsset(t.estate, car, 7 * 86400)).rejects.toThrow(/^NotVerifier/);
    t.svc.simulateAllSeatsVacant();
    t.act("zanele");
    await expect(t.svc.listAsset(t.estate, car, 7 * 86400)).rejects.toThrow(/^NotVerifier/);
    t.act("lerato");
    await t.svc.listAsset(t.estate, car, 7 * 86400);
    expect((await t.snap()).assets[0].status).toBe("Listed");
  });

  it("family relists an ended listing with no acceptable offer, never over one and never while it runs", async () => {
    const ended = async (stage: "listed" | "lowOffers") => {
      await start(stage);
      const saved = JSON.parse(window.localStorage.getItem(MOCK_STORE_KEY)!);
      saved.snap.estate.verifiers = [NO_WALLET, NO_WALLET, NO_WALLET];
      window.localStorage.setItem(MOCK_STORE_KEY, JSON.stringify(saved));
      const u = await open(createMockService({ instant: true }));
      const car = (await u.snap()).assets[0].address;
      u.act("lerato");
      await expect(u.svc.listAsset(u.estate, car, 7 * 86400)).rejects.toThrow(/^NotVerifier/);
      advance(7 * 86400);
      return { ...u, car };
    };
    storage();
    const low = await ended("lowOffers");
    await low.svc.listAsset(low.estate, low.car, 7 * 86400);
    expect((await low.snap()).assets[0].listingEnds).toBe(now() + 7 * 86400);
    const good = await ended("listed");
    await expect(good.svc.listAsset(good.estate, good.car, 7 * 86400)).rejects.toThrow(/^NotVerifier/);
  });

  it("monitors, backups and the fallback list see the estate in their list; a stranger is only a buyer", async () => {
    const t = await start("guardians");
    for (const w of [who("zodwa"), kagiso.wallet, DEMO_GUARDIANS.charity.wallet]) expect((await t.svc.listEstatesFor(w))[0].role).toBe("monitor");
    expect((await t.svc.listEstatesFor(NEW.wallet))[0].role).toBe("buyer");
  });
});

describe("C2: a document the review would refuse is refused before anything changes", () => {
  it("the old text stand-in is refused and no claim is made", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("unlocked");
    svc.setActor({ address: who("lerato"), role: "beneficiary", label: P("lerato").label });
    const [{ estate }] = await svc.listEstatesFor(who("lerato"));
    const snap = await svc.getEstate(estate);
    const rule = snap.rules.find((r) => r.category === "Tuition" && r.beneficiary === who("lerato"))!;
    const payee = snap.payees.find((p) => p.kind === rule.allowedPayeeKind)!;
    const fake = new File(["Heirloom demo document: fee-statement-2027.pdf"], "fee-statement-2027.pdf", { type: "application/pdf" });
    await expect(svc.submitClaim(estate, { rule: rule.address, payee: payee.wallet, amountUsdt: 10, evidence: fake })).rejects.toMatchObject({ code: "FileType" });
    expect((await svc.getEstate(estate)).claims).toHaveLength(snap.claims.length);
  });
});

describe("H9: a request the owner declined is never approved after the death", () => {
  it("refuses the trusted person's approval", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const [{ estate }] = await svc.listEstatesFor(who("thabo"));
    svc.setActor({ address: who("thabo"), role: "owner", label: P("thabo").label });
    const ask = (await svc.getEstate(estate)).claims.find((c) => c.status === "Open")!;
    await svc.declineAsk(estate, ask.address);
    svc.simulatePassing();
    svc.skipWait();
    svc.setActor({ address: who("nomsa"), role: "verifier", label: P("nomsa").label });
    await expect(svc.approveClaim(estate, ask.address)).rejects.toMatchObject({ code: "Declined" });
  });
});

describe("H7: a review that didn't finish is asked for again, with the same file", () => {
  it("a claim waits for its review, and only its own file brings it", async () => {
    let down = true;
    const t = await start("unlocked", { opts: { agent: () => (down ? "down" : null) } });
    t.act("lerato");
    const s = await t.snap();
    const rule = s.rules.find((r) => r.category === "Tuition" && r.beneficiary === who("lerato"))!;
    const payee = s.payees.find((p) => p.kind === rule.allowedPayeeKind)!;
    const file = pdf("fees.pdf");
    await expect(t.svc.submitClaim(t.estate, { rule: rule.address, payee: payee.wallet, amountUsdt: 10, evidence: file })).rejects.toMatchObject({ code: "ReviewPending" });
    const claim = (await t.snap()).claims.find((c) => c.agentVerdict === "Pending")!;
    expect(claim.status).toBe("Open");
    down = false;
    await expect(t.svc.requestReview(t.estate, { kind: "claim", subject: claim.address, evidence: new File(["%PDF-1.4 other"], "other.pdf", { type: "application/pdf" }) }))
      .rejects.toMatchObject({ code: "hash_mismatch" });
    t.act("sipho");
    await expect(t.svc.requestReview(t.estate, { kind: "claim", subject: claim.address, evidence: file })).rejects.toMatchObject({ code: "forbidden" });
    t.act("lerato");
    await t.svc.requestReview(t.estate, { kind: "claim", subject: claim.address, evidence: file });
    expect((await t.snap()).claims.find((c) => c.address === claim.address)!.agentVerdict).toBe("Approved");
  });

  it("a hardship request too: it can be made only once, so it must never be stranded", async () => {
    let down = true;
    const t = await start("unlocked", { opts: { agent: () => (down ? "down" : null) } });
    t.act("lerato");
    const asset = (await t.snap()).assets[0].address;
    const file = pdf("affidavit.pdf");
    await expect(t.svc.submitHardship(t.estate, { asset, evidence: file })).rejects.toMatchObject({ code: "ReviewPending" });
    const h = (await t.snap()).hardships[0];
    expect(h.agentVerdict).toBe("Pending");
    down = false;
    await t.svc.requestReview(t.estate, { kind: "hardship", subject: h.address, evidence: file });
    expect((await t.snap()).hardships[0].agentVerdict).toBe("Approved");
  });
});

describe("H6: a plan whose signing was interrupted is finished", () => {
  it("interrupt (a reload while signing), reload, resume", async () => {
    storage();
    const first = createMockService();
    first.setActor({ address: who("thabo"), role: "owner", label: P("thabo").label });
    const { draft } = await first.willChat([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }]);
    // The page closes while the plan is being signed: the signing never finishes.
    void first.createEstateFromWill(draft!);
    await Promise.resolve();
    const reloaded = createMockService({ instant: true });
    reloaded.setActor({ address: who("thabo"), role: "owner", label: P("thabo").label });
    const left = await reloaded.unfinishedSigning();
    expect(left?.draft.ownerName).toBe(draft!.ownerName);
    await reloaded.createEstateFromWill(left!.draft, left!.options);
    expect(await reloaded.unfinishedSigning()).toBeNull();
    expect((await reloaded.listEstatesFor(who("thabo")))).toHaveLength(1);
  });
});

describe("M4: the plan's asset terms reach the asset", () => {
  it("the demo keeps the signed plan's asset to fill in, until it is added", async () => {
    storage();
    const svc = createMockService({ instant: true });
    svc.setActor({ address: who("thabo"), role: "owner", label: P("thabo").label });
    const { draft } = await svc.willChat([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }]);
    const { estate } = await svc.createEstateFromWill(draft!);
    expect((await svc.getEstate(estate)).plannedAssets?.[0].title).toBe(draft!.assets[0].title);
  });
});

describe("Low: a schedule pays what was shown or nothing", () => {
  it("refuses when the rule now pays another amount or payee", async () => {
    const t = await start("funded");
    const r = (await t.snap()).rules.find((x) => x.recurringAmount > 0n && x.startsNow)!;
    t.svc.makeDue();
    await expect(t.svc.executeScheduled(t.estate, r.address, { amount: r.recurringAmount + 1n, payee: r.fixedPayee! })).rejects.toMatchObject({ code: "ScheduleChanged" });
    await t.svc.executeScheduled(t.estate, r.address, { amount: r.recurringAmount, payee: r.fixedPayee! });
  });
});

describe("Low: the demo signs a plan as the chain does", () => {
  it("adds no payee the plan didn't name, and a living schedule is first due one interval later", async () => {
    storage();
    const svc = createMockService({ instant: true });
    svc.setActor({ address: who("thabo"), role: "owner", label: P("thabo").label });
    const { draft } = await svc.willChat([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }]);
    const { estate } = await svc.createEstateFromWill(draft!);
    const s = await svc.getEstate(estate);
    expect(s.payees.some((p) => p.wallet === who("lerato"))).toBe(false);
    const living = s.rules.find((r) => r.startsNow && r.recurringAmount > 0n)!;
    expect(living.nextDue).toBe(now() + 60);
  });
});

describe("A removed family member can be added back", () => {
  it("in the plan again; the rules that ended stay ended", async () => {
    const t = await start("funded");
    const rulesBefore = (await t.snap()).rules.filter((r) => r.beneficiary === who("sipho"));
    await t.svc.removeMember(t.estate, { beneficiary: who("sipho") });
    await t.svc.restoreMember(t.estate, who("sipho"));
    const s = await t.snap();
    expect(s.beneficiaries.find((b) => b.wallet === who("sipho"))?.active).toBe(true);
    for (const r of rulesBefore) expect(s.rules.find((x) => x.address === r.address)!.validUntil).toBeLessThan(now());
    await expect(t.svc.restoreMember(t.estate, who("sipho"))).rejects.toThrow(/^BadStatus/);
  });
});

describe("review wave (plan 18.10): the mock as the program", () => {
  const { charity } = DEMO_GUARDIANS;

  it("a trusted person and a living listed fallback recipient may report the owner's death, the agent never", async () => {
    const t = await start("funded", { guarded: true });
    await t.death("nomsa");
    expect((await t.snap()).estate.death.submittedBy).toBe(who("nomsa"));

    const f = await start("funded", { guarded: true });
    f.be(charity.wallet, "Charity"); await f.svc.submitDeathClaim(f.estate, pdf());
    expect((await f.snap()).estate.death.submittedBy).toBe(charity.wallet);

    const a = await start("funded", { guarded: true });
    a.be((await a.snap()).estate.agent, "Agent");
    await expect(a.svc.submitDeathClaim(a.estate, pdf())).rejects.toThrow(/^NotParticipant/);
    a.act("zanele");
    await expect(a.svc.submitDeathClaim(a.estate, pdf())).rejects.toThrow(/^NotBeneficiary/);
  });

  it("the only trusted person left, who gains, decides alone: the unlock waits twice, the claim's window too", async () => {
    const t = await start("funded", { guarded: true });
    t.act("thabo"); await t.svc.ownerReplaceSeat(t.estate, 0, { wallet: who("lerato"), name: "Lerato" });
    await t.vacate(1); await t.vacate(2);
    expect((await t.snap()).estate.verifiers.filter((v) => v !== NO_WALLET)).toEqual([who("lerato")]);
    await t.death("lerato");
    t.act("lerato"); await t.svc.attestDeath(t.estate);
    expect((await t.snap()).estate.death).toMatchObject({ decidedAlone: true, attestations: [true, false, false] });
    advance(60);
    await expect(t.svc.finalizeUnlock(t.estate)).rejects.toThrow(/^WaitingPeriodNotOver/);
    advance(60);
    await t.svc.finalizeUnlock(t.estate);

    const c = await t.claim("lerato");
    t.act("lerato"); await t.svc.approveClaim(t.estate, c);
    expect((await t.theClaim(c)).decidedAlone).toBe(true);
    expect((await t.snap()).guardians!.claimPayableAt?.[c]).toBe(now() + 120);
    advance(60);
    await expect(t.svc.executeClaim(t.estate, c)).rejects.toThrow(/^ObjectionWindowOpen/);
    advance(60);
    await t.svc.executeClaim(t.estate, c);
  });

  it("not when the agent referred it", async () => {
    let agent: "unsure" | null = null;
    const t = await start("funded", { guarded: true, opts: { agent: () => agent } });
    t.act("thabo"); await t.svc.ownerReplaceSeat(t.estate, 0, { wallet: who("lerato"), name: "Lerato" });
    await t.vacate(1); await t.vacate(2);
    agent = "unsure";
    await t.death("lerato");
    expect((await t.snap()).estate.death.verdict).toBe("Referred");
    t.act("lerato");
    await expect(t.svc.attestDeath(t.estate)).rejects.toThrow(/^OwnApproval/);
  });

  it("with guardians an offer waits out the objection window before it is accepted", async () => {
    const t = await start("guardians");
    const car = (await t.snap()).assets[0].address;
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 7 * 86_400);
    t.act("david");
    const r = await t.svc.rankOffers(car);
    expect(r.bestOffer).toBeNull();
    expect(r.ineligible.filter((x) => x.readyAt).map((x) => x.readyAt)).toContain(now() + 60);
    await expect(t.svc.acceptBestOffer(t.estate, car)).rejects.toThrow(/^ObjectionWindowOpen/);
    advance(60);
    await t.svc.acceptBestOffer(t.estate, car);
    expect((await t.snap()).assets[0].status).toBe("Sold");
  });

  it("an offer made before an upheld objection to the sale is never accepted (OfferTooOld); a decided objection reads its decision time", async () => {
    const t = await start("guardians");
    const car = (await t.snap()).assets[0].address;
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 7 * 86_400);
    const old = (await t.snap()).offers.map((o) => o.address);
    advance(10);
    t.act("zodwa"); await t.svc.raiseObjection(t.estate, { kind: "Sale", target: car, seatIndex: 2, reason: "Too cheap." });
    advance(5);
    for (const k of ["nomsa", "david"]) { t.act(k); await t.svc.voteObjection(t.estate, (await t.snap()).guardians!.objections[0].address, true).catch(() => undefined); }
    const objection = (await t.snap()).guardians!.objections.find((o) => o.target === car)!;
    expect(objection).toMatchObject({ status: "Upheld", raisedAt: now() });
    advance(1);
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 7 * 86_400);
    advance(60);
    t.act("david");
    const r = await t.svc.rankOffers(car);
    for (const o of old) expect(r.ineligible.find((x) => x.offer === o)?.reason).toMatch(/objection to the sale was upheld/);
    expect(old).not.toContain(r.bestOffer);
  });

  it("a hardship's approval waits out the objection window before the sale", async () => {
    const t = await start("guardians");
    const car = (await t.snap()).assets[0].address;
    t.act("nomsa"); await t.svc.listAsset(t.estate, car, 7 * 86_400);
    advance(60);
    t.act("lerato"); await t.svc.submitHardship(t.estate, { asset: car, evidence: pdf("affidavit.pdf") });
    const h = (await t.snap()).hardships[0].address;
    for (const k of ["nomsa", "david"]) { t.act(k); await t.svc.approveHardship(t.estate, h).catch(() => undefined); }
    expect((await t.snap()).hardships[0].status).toBe("Approved");
    t.act("david");
    await expect(t.svc.acceptBestOffer(t.estate, car)).rejects.toThrow(/^ObjectionWindowOpen/);
    advance(60);
    await t.svc.acceptBestOffer(t.estate, car);
    expect((await t.snap()).assets[0].status).toBe("Sold");
  });

  it("a new agent reviews again what the old one reviewed, and can't be anyone's backup", async () => {
    const t = await start("funded", { guarded: true });
    t.act("zodwa"); await t.svc.reportSeatDeath(t.estate, 2, pdf());
    expect((await t.snap()).guardians!.seats[2].succession?.verdict).toBe("Approved");
    t.act("thabo");
    await expect(t.svc.setAgent(t.estate, DEMO_GUARDIANS.kagiso.wallet)).rejects.toThrow(/^BadAgent/);
    await t.svc.setAgent(t.estate, NEW_AGENT);
    const s = await t.snap();
    expect(s.guardians!.seats[2].succession).toMatchObject({ verdict: "Pending", confirmedBy: null });
    expect(s.activity.map((a) => a.kind)).toContain("AgentReviewCleared");
  });

  it("a new fallback list voids every open report about a recipient", async () => {
    const t = await start("guardians");
    t.act("nomsa"); await t.svc.reportFallbackDeath(t.estate, 0, pdf());
    expect((await t.snap()).guardians!.fallback.recipients[0].report).toBeTruthy();
    const list = (await t.snap()).guardians!.fallback.recipients.map((r) => ({ wallet: r.wallet, name: r.name, kind: r.kind }));
    const f = await start("funded", { guarded: true });
    f.act("nomsa"); await f.svc.reportFallbackDeath(f.estate, 0, pdf());
    f.act("thabo"); await f.svc.setFallback(f.estate, list);
    expect((await f.snap()).guardians!.fallback.recipients[0].report ?? null).toBeNull();
  });
});

describe("a disproved passing, as the program (DeathDisproved)", () => {
  it("an older check-in after the claim: nobody confirms or unlocks it, and anyone who may report replaces it at once", async () => {
    const saved = storage();
    const first = await start();
    await first.death(); await first.attest("nomsa", "david");
    expect((await first.snap()).estate.status).toBe("DeathPending");
    // The older program's check-in didn't clear the claim: a sign of life stored after it.
    saved.edit((s) => { s.snap.estate.lastHeartbeat = now() + 1; });
    advance(120);
    const t = await open(createMockService({ instant: true }));
    await expect(t.svc.finalizeUnlock(t.estate)).rejects.toThrow(/^DeathDisproved/);
    await t.death("nomsa"); // a trusted person replaces it at once
    const e = (await t.snap()).estate;
    expect([e.status, e.death.submittedBy, e.death.attestations]).toEqual(["Active", who("nomsa"), [false, false, false]]);
  });
});

describe("a succession wait stored as 0 (Guard::succession_wait)", () => {
  it("reads and waits as 60 s", async () => {
    const saved = storage();
    await start("funded", { guarded: true });
    saved.edit((s) => { s.guard.successionWaitSecs = 0; });
    const t = await open(createMockService({ instant: true }));
    expect((await t.snap()).guardians!.successionWaitSecs).toBe(60);
    t.svc.simulateSeatPassing(2);
    advance(30);
    await expect(t.svc.finalizeSuccession(t.estate, 2)).rejects.toThrow(/^WaitingPeriodNotOver/);
    advance(31);
    await t.svc.finalizeSuccession(t.estate, 2);
  });
});

describe("the agent's recovery route (H7, re-review)", () => {
  it("only while the death claim is unreviewed, from max(sign of life, claim) + RT; the lone trusted person who gains waits 2 RT", async () => {
    let down = false;
    const t = await start("funded", { guarded: true, opts: { agent: () => (down ? "down" : null) } });
    t.act("thabo"); await t.svc.ownerReplaceSeat(t.estate, 0, { wallet: who("lerato"), name: "Lerato" });
    await t.vacate(1); await t.vacate(2);
    down = true;
    await t.death("lerato");
    const since = now();
    const rt = 4 * 60; // W = 60 s
    t.act("lerato");
    advance(rt);
    expect(now()).toBe(since + rt);
    await expect(t.svc.voteAgent(t.estate, NEW_AGENT)).rejects.toThrow(/^WaitingPeriodNotOver: You are the only trusted person left/);
    advance(rt);
    await t.svc.voteAgent(t.estate, NEW_AGENT);
    expect((await t.snap()).estate.agent).toBe(NEW_AGENT);
  });

  it("not once the agent has reviewed the claim", async () => {
    const t = await start();
    await t.death("lerato");
    advance(10_000);
    t.act("nomsa");
    await t.svc.voteAgent(t.estate, NEW_AGENT);
    expect((await t.snap()).estate.agent).not.toBe(NEW_AGENT); // every held seat still has to vote
  });
});
