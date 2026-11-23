/** Guardians in the mock service (docs/guardians-spec.md §2): the mock is the contract's twin, one test per rule. */
import { describe, expect, it } from "vitest";
import { createMockService, DEMO_GUARDIANS, DEMO_PERSONAS } from "./mock";
import { photosRootHex } from "../guardians/photos";
import { mediaRootHex } from "../assets/spec";

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const act = (svc: Svc, key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };
const actAs = (svc: Svc, address: string, label: string) => svc.setActor({ address, role: "verifier", label });
const pdf = (name = "death-certificate.pdf") => new File(["%PDF-1.4 demo"], name, { type: "application/pdf" });

/** "guardians" = unlocked estate with a Guard; "funded" = active estate, guardians added by the owner's shortcut. */
async function start(stage: "funded" | "guardians" = "guardians") {
  const svc = createMockService({ instant: true });
  svc.resetDemo(stage);
  if (stage === "funded") svc.setupDemoGuardians();
  act(svc, "thabo");
  const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
  return { svc, estate, guardians: () => svc.getGuardians(estate), snap: () => svc.getEstate(estate) };
}

/** Uncle Bongani approves one of Lerato's claims; returns the claim address. */
async function bonganiApproved(svc: Svc, estate: string) {
  svc.simulateSeatApproval(2);
  return (await svc.getGuardians(estate)).feed[0].target;
}

describe("stock demo without a Guard (the 12-step guide) is unchanged", () => {
  it("unlocked: a trusted person approves and the claim pays at once", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("unlocked");
    act(svc, "thabo");
    const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
    expect((await svc.getGuardians(estate)).enabled).toBe(false);
    svc.simulateSeatApproval(0); // Adv. Ndlovu approves Lerato's fees
    const claim = (await svc.getEstate(estate)).claims.find((c) => c.status === "Open")!;
    await svc.executeClaim(estate, claim.address);
    expect((await svc.getEstate(estate)).claims.find((c) => c.address === claim.address)?.status).toBe("Paid");
  });

  it("funded: the owner approves a living-plan claim and it pays at once", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    act(svc, "lerato");
    const [{ estate }] = await svc.listEstatesFor(P("lerato").address);
    const snap = await svc.getEstate(estate);
    const rule = snap.rules.find((r) => r.startsNow && r.category === "Tuition")!;
    const payee = snap.payees.find((p) => p.kind === rule.allowedPayeeKind)!;
    const { claim } = await svc.submitClaim(estate, { rule: rule.address, payee: payee.wallet, amountUsdt: 1000, evidence: pdf("fees.pdf") });
    act(svc, "thabo");
    await svc.ownerApproveClaim(estate, claim);
    await svc.executeClaim(estate, claim);
    expect((await svc.getEstate(estate)).claims.find((c) => c.address === claim)?.status).toBe("Paid");
    expect((await svc.getGuardians(estate)).enabled).toBe(false);
  });
});

describe("mock guardians: setup", () => {
  it("seeds Thabo's guardians: Bongani's backups Kagiso then Adv. Naidoo, watched by Aunt Zodwa; the fallback order", async () => {
    const { guardians, svc } = await start("funded");
    const g = await guardians();
    expect(g.enabled).toBe(true);
    expect([g.objectionWindowSecs, g.successionWaitSecs, g.fallbackWaitSecs]).toEqual([60, 60, 120]);
    expect(g.seats.map((s) => s.holderName)).toEqual(["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"]);
    expect(g.seats[2].backups.map((b) => b.wallet)).toEqual([DEMO_GUARDIANS.kagiso.wallet, DEMO_GUARDIANS.priya.wallet]);
    expect(g.seats[2].monitors.map((m) => m.wallet)).toEqual([P("zodwa").address]);
    expect(g.fallback.recipients.map((r) => r.name)).toEqual(["Lerato (daughter)", "Sipho (son)", "Naledi (daughter)", "Ithemba Children's Charity"]);
    expect((await svc.listEstatesFor(P("zodwa").address))[0].role).toBe("monitor");
  });

  it("rejects bad backups and monitors, and lets only the owner or the holder change them", async () => {
    const { svc, estate } = await start("funded");
    await expect(svc.setSeatBackups(estate, 2, [{ wallet: P("thabo").address, name: "Thabo" }])).rejects.toThrow(/^BadBackup/);
    await expect(svc.setSeatBackups(estate, 2, [{ wallet: P("nomsa").address, name: "Ndlovu" }])).rejects.toThrow(/^BadBackup/);
    await expect(svc.setSeatMonitors(estate, 2, [{ wallet: P("busi").address, name: "Bongani" }])).rejects.toThrow(/^BadMonitor/);
    act(svc, "zodwa");
    await expect(svc.setSeatMonitors(estate, 2, [])).rejects.toThrow(/^NotOwner/);
    act(svc, "busi");
    await expect(svc.setSeatMonitors(estate, 2, [])).rejects.toThrow(/^NotOwner/);
    await svc.setSeatBackups(estate, 2, [{ ...DEMO_GUARDIANS.priya }]); // the holder may name his own backups
  });
});

describe("mock guardians: monitors and objections", () => {
  it("records each seat approval in the monitors' feed", async () => {
    const { svc, estate, guardians } = await start();
    const claim = await bonganiApproved(svc, estate);
    const item = (await guardians()).feed[0];
    expect(item).toMatchObject({ seatIndex: 2, kind: "Claim", target: claim, approver: P("busi").address, approverName: "Uncle Bongani Mokoena" });
    expect(item.objectionDeadline).toBe(item.ts + 60);
    expect((await guardians()).claimPayableAt?.[claim]).toBe(item.ts + 60);
  });

  it("a monitor can only object to an approval the watched person made", async () => {
    const { svc, estate } = await start();
    svc.simulateSeatApproval(0); // Adv. Ndlovu approves, not Bongani
    const claim = (await svc.getGuardians(estate)).feed[0].target;
    act(svc, "zodwa");
    await expect(svc.raiseObjection(estate, { kind: "Claim", target: claim, seatIndex: 2, reason: "No" })).rejects.toThrow(/^BadStatus/);
  });

  it("a payment waits for the objection window", async () => {
    const { svc, estate, snap } = await start();
    const claim = await bonganiApproved(svc, estate);
    await expect(svc.executeClaim(estate, claim)).rejects.toThrow(/^ObjectionWindowOpen/);
    svc.endObjectionWindow();
    await svc.executeClaim(estate, claim);
    expect((await snap()).claims.find((c) => c.address === claim)?.status).toBe("Paid");
  });

  it("only a monitor of that trusted person can object", async () => {
    const { svc, estate } = await start();
    const claim = await bonganiApproved(svc, estate);
    for (const key of ["lerato", "nomsa"]) {
      act(svc, key);
      await expect(svc.raiseObjection(estate, { kind: "Claim", target: claim, seatIndex: 2, reason: "No" })).rejects.toThrow(/^NotMonitor/);
    }
    act(svc, "zodwa"); // she watches seat 2, not seat 0
    await expect(svc.raiseObjection(estate, { kind: "Claim", target: claim, seatIndex: 0, reason: "No" })).rejects.toThrow(/^NotMonitor/);
  });

  it("an objection pauses the payment until two trusted people dismiss it", async () => {
    const { svc, estate, guardians } = await start();
    const claim = await bonganiApproved(svc, estate);
    act(svc, "zodwa");
    await svc.raiseObjection(estate, { kind: "Claim", target: claim, seatIndex: 2, reason: "Lerato already paid this term." });
    await expect(svc.raiseObjection(estate, { kind: "Claim", target: claim, seatIndex: 2, reason: "Again" })).rejects.toThrow(/^ObjectionOpen/);
    const o = (await guardians()).objections[0];
    expect(o).toMatchObject({ status: "Open", monitorName: "Aunt Zodwa Mokoena", reason: "Lerato already paid this term.", seatIndex: 2 });
    expect(o.reasonHash).toMatch(/^[0-9a-f]{64}$/);
    svc.endObjectionWindow();
    await expect(svc.executeClaim(estate, claim)).rejects.toThrow(/^ObjectionOpen/);
    act(svc, "busi"); // the person being watched cannot vote
    await expect(svc.voteObjection(estate, o.address, false)).rejects.toThrow(/^NotVerifier/);
    act(svc, "nomsa");
    await svc.voteObjection(estate, o.address, false);
    await expect(svc.voteObjection(estate, o.address, false)).rejects.toThrow(/^AlreadyApproved/);
    expect((await guardians()).objections[0].status).toBe("Open");
    act(svc, "david");
    await svc.voteObjection(estate, o.address, false);
    expect((await guardians()).objections[0]).toMatchObject({ status: "Dismissed", votesDismiss: 2 });
    await svc.executeClaim(estate, claim);
  });

  it("an upheld objection rejects the claim", async () => {
    const { svc, estate, guardians, snap } = await start();
    const claim = await bonganiApproved(svc, estate);
    act(svc, "zodwa");
    await svc.raiseObjection(estate, { kind: "Claim", target: claim, seatIndex: 2, reason: "Wrong institution." });
    const o = (await guardians()).objections[0];
    act(svc, "nomsa"); await svc.voteObjection(estate, o.address, true);
    act(svc, "david"); await svc.voteObjection(estate, o.address, true);
    expect((await guardians()).objections[0]).toMatchObject({ status: "Upheld", votesUphold: 2 });
    expect((await snap()).claims.find((c) => c.address === claim)?.status).toBe("Rejected");
    svc.endObjectionWindow();
    await expect(svc.executeClaim(estate, claim)).rejects.toThrow(/^BadStatus/);
  });

  it("the owner decides an objection alone while the estate is active", async () => {
    const { svc, estate, guardians } = await start("funded");
    // While Thabo is alive only he approves claims (R3): what Uncle Bongani can approve is a reported passing.
    act(svc, "lerato");
    await svc.submitDeathClaim(estate, pdf());
    svc.simulateSeatApproval(2);
    act(svc, "zodwa");
    await svc.raiseObjection(estate, { kind: "Unlock", target: estate, seatIndex: null, reason: "Check first." });
    act(svc, "thabo");
    await svc.voteObjection(estate, (await guardians()).objections[0].address, false);
    expect((await guardians()).objections[0].status).toBe("Dismissed");
  });

  it("an objection to the unlock pauses it; upheld, the passing report is cancelled", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    svc.setupDemoGuardians();
    svc.simulatePassing();
    act(svc, "thabo");
    const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
    act(svc, "zodwa");
    await svc.raiseObjection(estate, { kind: "Unlock", target: estate, seatIndex: null, reason: "Thabo called me today." });
    await expect(svc.finalizeUnlock(estate)).rejects.toThrow(/^(ObjectionOpen|WaitingPeriodNotOver)/);
    expect(() => svc.skipWait()).toThrow(/^ObjectionOpen/);
    const o = (await svc.getGuardians(estate)).objections[0];
    act(svc, "nomsa"); await svc.voteObjection(estate, o.address, true);
    act(svc, "busi"); await svc.voteObjection(estate, o.address, true);
    expect((await svc.getEstate(estate)).estate.status).toBe("Active");
  });
});

describe("mock guardians: succession", () => {
  it("after a confirmed passing and the wait, backups[0] takes the seat and can approve", async () => {
    const { svc, estate, guardians, snap } = await start();
    act(svc, "zodwa");
    const { report } = await svc.reportSeatDeath(estate, 2, pdf());
    expect(report.verdict).toBe("approve");
    expect(report.extracted["Full name"]).toBe("Uncle Bongani Mokoena");
    await expect(svc.finalizeSuccession(estate, 2)).rejects.toThrow(/^NotConfirmer/);
    expect((await guardians()).seats[2].succession).toMatchObject({ pendingSince: 0, readyAt: 0 }); // the wait starts at confirmation
    act(svc, "nomsa");
    await svc.confirmSeatDeath(estate, 2);
    const sc = (await guardians()).seats[2].succession!;
    expect(sc).toMatchObject({ verdict: "Approved", confirmedBy: P("nomsa").address, readyAt: sc.pendingSince + 60 });
    expect(sc.nextHolder?.wallet).toBe(DEMO_GUARDIANS.kagiso.wallet);
    await expect(svc.finalizeSuccession(estate, 2)).rejects.toThrow(/^WaitingPeriodNotOver/);
    svc.endSuccessionWait();
    await svc.finalizeSuccession(estate, 2);
    const seat = (await guardians()).seats[2];
    expect(seat).toMatchObject({ holder: DEMO_GUARDIANS.kagiso.wallet, holderName: "Cousin Kagiso Mokoena", generation: 1, vacant: false, succession: null });
    expect(seat.backups.map((b) => b.wallet)).toEqual([DEMO_GUARDIANS.priya.wallet]);
    expect(seat.monitors.map((m) => m.wallet)).toEqual([P("zodwa").address]); // monitors survive succession
    expect((await snap()).estate.verifiers[2]).toBe(DEMO_GUARDIANS.kagiso.wallet);
    svc.simulateSeatApproval(2); // Kagiso now approves as the trusted person
    expect((await guardians()).feed[0].approver).toBe(DEMO_GUARDIANS.kagiso.wallet);
  });

  it("the chain of succession runs twice (generation 2), then the seat is vacant", async () => {
    const { svc, estate, guardians } = await start();
    for (const next of [DEMO_GUARDIANS.kagiso.wallet, DEMO_GUARDIANS.priya.wallet, null]) {
      svc.simulateSeatPassing(2);
      svc.endSuccessionWait();
      await svc.finalizeSuccession(estate, 2);
      expect((await guardians()).seats[2].holder).toBe(next);
    }
    expect((await guardians()).seats[2]).toMatchObject({ generation: 3, vacant: true });
  });

  it("the reporter cannot confirm, nor can the backup who would take the seat", async () => {
    const { svc, estate } = await start();
    act(svc, "nomsa");
    await svc.reportSeatDeath(estate, 2, pdf());
    await expect(svc.confirmSeatDeath(estate, 2)).rejects.toThrow(/^NotConfirmer/);
    actAs(svc, DEMO_GUARDIANS.kagiso.wallet, DEMO_GUARDIANS.kagiso.name);
    await expect(svc.confirmSeatDeath(estate, 2)).rejects.toThrow(/^NotConfirmer/);
    act(svc, "zodwa"); // other trusted people are alive, so a monitor cannot confirm
    await expect(svc.confirmSeatDeath(estate, 2)).rejects.toThrow(/^NotConfirmer/);
  });

  it("the holder can say \"I'm still here\", but cannot report his own passing", async () => {
    const { svc, estate, guardians } = await start();
    act(svc, "busi");
    await expect(svc.reportSeatDeath(estate, 2, pdf())).rejects.toThrow(/^BadStatus/);
    act(svc, "zodwa");
    await svc.reportSeatDeath(estate, 2, pdf());
    await expect(svc.reportSeatDeath(estate, 2, pdf())).rejects.toThrow(/^SuccessionPending/);
    act(svc, "busi");
    await svc.vetoSeatDeath(estate, 2);
    expect((await guardians()).seats[2].succession).toBeNull();
    act(svc, "david");
    await expect(svc.confirmSeatDeath(estate, 2)).rejects.toThrow(/^NoSuccessionPending/);
  });

  it("a rejected certificate changes nothing", async () => {
    const { svc, estate, guardians } = await start();
    act(svc, "zodwa");
    const { report } = await svc.reportSeatDeath(estate, 2, pdf("death-certificate-edited.pdf"));
    expect(report.verdict).toBe("reject");
    expect((await guardians()).seats[2].succession).toBeNull();
  });

  it("a seat with no backups becomes vacant, and a vacant seat cannot be reported again", async () => {
    const { svc, estate, guardians, snap } = await start();
    act(svc, "lerato");
    await svc.reportSeatDeath(estate, 0, pdf());
    act(svc, "david");
    await svc.confirmSeatDeath(estate, 0);
    svc.endSuccessionWait();
    await svc.finalizeSuccession(estate, 0);
    expect((await guardians()).seats[0]).toMatchObject({ holder: null, vacant: true, generation: 1 });
    expect((await snap()).estate.verifiers[0]).toBe("11111111111111111111111111111111");
    act(svc, "lerato");
    await expect(svc.reportSeatDeath(estate, 0, pdf())).rejects.toThrow(/^SeatVacant/);
  });

  it("an open objection on the succession blocks it", async () => {
    const { svc, estate, guardians } = await start();
    svc.simulateSeatPassing(2);
    svc.endSuccessionWait();
    act(svc, "zodwa");
    const seat = (await guardians()).seats[2];
    await svc.raiseObjection(estate, { kind: "Succession", target: seat.address, seatIndex: 2, reason: "Bongani is in hospital, not dead." });
    await expect(svc.finalizeSuccession(estate, 2)).rejects.toThrow(/^ObjectionOpen/);
  });
});

describe("mock guardians: fallback plan", () => {
  it("cannot start while any seat is filled", async () => {
    const { svc, estate, guardians } = await start();
    expect((await guardians()).fallback.canStart).toBe(false);
    await expect(svc.startFallback(estate)).rejects.toThrow(/^SeatsNotVacant/);
  });

  it("pays the whole vault to the first recipient not proven dead", async () => {
    const { svc, estate, guardians, snap } = await start();
    svc.simulateAllSeatsVacant();
    expect((await guardians()).fallback.canStart).toBe(true);
    act(svc, "sipho");
    const { report } = await svc.reportFallbackDeath(estate, 0, pdf());
    expect(report.extracted["Full name"]).toBe("Lerato"); // the plain name, never the role label
    // The agent's word alone never marks a recipient dead (R4): a second person confirms after the wait.
    expect((await guardians()).fallback.recipients[0].dead).toBe(false);
    svc.endFallbackWait();
    act(svc, "naledi");
    await svc.resolveFallbackDeath(estate, 0, true);
    expect((await guardians()).fallback.recipients[0].dead).toBe(true);
    await expect(svc.reportFallbackDeath(estate, 0, pdf())).rejects.toThrow(/^BadStatus/); // already recorded
    await svc.startFallback(estate);
    await expect(svc.executeFallback(estate)).rejects.toThrow(/^WaitingPeriodNotOver/);
    svc.endFallbackWait();
    const vault = (await snap()).estate.vaultBalance;
    expect(vault).toBeGreaterThan(0n);
    const before = svc.balanceOf(P("sipho").address) ?? 0n;
    await svc.executeFallback(estate);
    expect(svc.balanceOf(P("sipho").address)).toBe(before + vault);
    expect((await snap()).estate.vaultBalance).toBe(0n);
    expect((await guardians()).fallback.done).toBe(true);
    await expect(svc.executeFallback(estate)).rejects.toThrow(/^FallbackDone/);
  });

  it("needs the owner's passing proven", async () => {
    const { svc, estate } = await start("funded");
    svc.simulateAllSeatsVacant(); // also reports Thabo's passing (agent-approved)
    await svc.startFallback(estate);
  });

  it("an open objection blocks the payout; family members may object", async () => {
    const { svc, estate, guardians } = await start();
    svc.simulateAllSeatsVacant();
    await svc.startFallback(estate);
    svc.endFallbackWait();
    const target = (await guardians()).address!;
    act(svc, "zanele"); // the car buyer is neither monitor nor family
    await expect(svc.raiseObjection(estate, { kind: "Fallback", target, seatIndex: null, reason: "No" })).rejects.toThrow(/^NotMonitor/);
    act(svc, "naledi");
    await svc.raiseObjection(estate, { kind: "Fallback", target, seatIndex: null, reason: "Lerato is alive." });
    await expect(svc.executeFallback(estate)).rejects.toThrow(/^ObjectionOpen/);
  });
});

describe("mock guardians: a fallback objection lapses (funds are never locked forever)", () => {
  async function objected() {
    const ctx = await start();
    const { svc, estate, guardians } = ctx;
    svc.simulateAllSeatsVacant();
    await svc.startFallback(estate);
    act(svc, "naledi");
    await svc.raiseObjection(estate, { kind: "Fallback", target: (await guardians()).address!, seatIndex: null, reason: "Wait for the family meeting." });
    return ctx;
  }

  it("shows when it lapses, and cannot be lapsed early", async () => {
    const { svc, estate, guardians } = await objected();
    const o = (await guardians()).objections[0];
    expect(o.lapsesAt).toBe(o.raisedAt + 120);
    await expect(svc.lapseObjection(estate)).rejects.toThrow(/^ObjectionNotLapsed/);
  });

  it("lapses into dismissed without restarting the countdown; no vote after the lapse time", async () => {
    const { svc, estate, guardians } = await objected();
    const before = (await guardians()).fallback.readyAt!;
    svc.endFallbackWait();
    const o = (await guardians()).objections[0];
    act(svc, "zodwa");
    await expect(svc.voteObjection(estate, o.address, true)).rejects.toThrow(/^ObjectionLapsed/);
    await svc.lapseObjection(estate);
    const g = await guardians();
    expect(g.objections[0]).toMatchObject({ status: "Dismissed", lapsesAt: null });
    expect(g.fallback.readyAt).toBe(before - 120); // only the demo clock moved; the countdown kept running
    await expect(svc.lapseObjection(estate)).rejects.toThrow(/^BadStatus/);
  });

  it("a dismissed or lapsed fallback objection cannot be raised again in the same countdown", async () => {
    const { svc, estate, guardians } = await objected();
    svc.endFallbackWait();
    await svc.lapseObjection(estate);
    act(svc, "sipho");
    await expect(svc.raiseObjection(estate, { kind: "Fallback", target: (await guardians()).address!, seatIndex: null, reason: "Again" }))
      .rejects.toThrow(/^BadStatus/);
  });

  it("execute_fallback lapses it itself and pays in the same step", async () => {
    const { svc, estate, guardians, snap } = await objected();
    await expect(svc.executeFallback(estate)).rejects.toThrow(/^WaitingPeriodNotOver/);
    svc.endFallbackWait();
    const vault = (await snap()).estate.vaultBalance;
    const before = svc.balanceOf(P("lerato").address) ?? 0n;
    await svc.executeFallback(estate);
    expect(svc.balanceOf(P("lerato").address)).toBe(before + vault);
    expect((await guardians()).objections[0].status).toBe("Dismissed");
    expect((await guardians()).fallback.done).toBe(true);
  });

  it("with a single monitor left, one vote cannot decide it: it stays open until it lapses", async () => {
    const { svc, estate, guardians } = await objected();
    const o = (await guardians()).objections[0];
    act(svc, "zodwa"); // Bongani's monitor decides once every trusted person is gone (one monitor: a tie stays open)
    await svc.voteObjection(estate, o.address, true);
    expect((await guardians()).objections[0].status).toBe("Open");
  });
});

describe("mock guardians: asset photos", () => {
  it("records the photos with the root of their hashes; the living owner only", async () => {
    const { svc, estate, snap } = await start("funded");
    const asset = (await snap()).assets[0].address;
    const photo = (n: string) => ({ sha256: n.repeat(64), url: `/p/${n}.webp`, width: 1600, height: 1200, bytes: 200_000 });
    await svc.setAssetMedia(estate, asset, { kind: "Car", title: "Corolla", photos: [photo("a"), photo("b")] });
    const m = (await svc.getAssetMedia(estate)).find((x) => x.asset === asset)!;
    expect(m).toMatchObject({ asset, kind: "Car", title: "Corolla" });
    expect(m.photosRoot).toBe(await mediaRootHex([photo("a"), photo("b")]));
    act(svc, "lerato");
    await expect(svc.setAssetMedia(estate, asset, { kind: "Car", title: "x", photos: [] })).rejects.toThrow(/^NotOwner/);
  });

  it("photosRootHex is order-sensitive and zero for no photos", async () => {
    expect(await photosRootHex([])).toBe("0".repeat(64));
    expect(await photosRootHex(["a".repeat(64), "b".repeat(64)])).not.toBe(await photosRootHex(["b".repeat(64), "a".repeat(64)]));
  });
});

describe("mock guardians: the owner replaces a trusted person (owner_replace_seat)", () => {
  const NEW = { wallet: "NewTrustedPerson1111111111111111111111111111", name: "Mr. Sizwe Dlamini" };

  it("swaps the holder at once: backups and monitors stay, the holder count goes up, the new person can approve", async () => {
    const { svc, estate, guardians, snap } = await start("funded");
    await svc.ownerReplaceSeat(estate, 2, NEW);
    const seat = (await guardians()).seats[2];
    expect(seat).toMatchObject({ holder: NEW.wallet, holderName: NEW.name, generation: 1, vacant: false, succession: null });
    expect(seat.backups.map((b) => b.wallet)).toEqual([DEMO_GUARDIANS.kagiso.wallet, DEMO_GUARDIANS.priya.wallet]);
    expect(seat.monitors.map((m) => m.wallet)).toEqual([P("zodwa").address]);
    const e = (await snap()).estate;
    expect(e.verifiers[2]).toBe(NEW.wallet);
    expect(e.verifierNames[2]).toBe(NEW.name);
    expect((await svc.listEstatesFor(P("busi").address)).some((x) => x.role === "verifier")).toBe(false);
    act(svc, "lerato");
    await svc.submitDeathClaim(estate, pdf());
    svc.simulateSeatApproval(2);
    expect((await guardians()).feed[0].approver).toBe(NEW.wallet);
  });

  it("a backup or monitor who takes the place is taken off this place's lists", async () => {
    const { svc, estate, guardians } = await start("funded");
    await svc.ownerReplaceSeat(estate, 2, DEMO_GUARDIANS.kagiso);
    let seat = (await guardians()).seats[2];
    expect(seat.backups.map((b) => b.wallet)).toEqual([DEMO_GUARDIANS.priya.wallet]);
    expect(seat.holderName).toBe("Cousin Kagiso Mokoena"); // a known person keeps their name
    await svc.ownerReplaceSeat(estate, 2, { wallet: P("zodwa").address, name: "Aunt Zodwa" });
    seat = (await guardians()).seats[2];
    expect(seat.monitors).toEqual([]);
    expect(seat.generation).toBe(2);
  });

  it("cancels a reported passing on that place", async () => {
    const { svc, estate, guardians } = await start("funded");
    svc.simulateSeatPassing(2);
    act(svc, "thabo");
    expect((await guardians()).seats[2].succession).not.toBeNull();
    await svc.ownerReplaceSeat(estate, 2, NEW);
    expect((await guardians()).seats[2].succession).toBeNull();
    await expect(svc.finalizeSuccession(estate, 2)).rejects.toThrow(/^NoSuccessionPending/);
  });

  it("fills an empty place", async () => {
    const { svc, estate, guardians, snap } = await start("funded");
    svc.simulateSeatPassing(0);
    svc.endSuccessionWait();
    await svc.finalizeSuccession(estate, 0);
    expect((await guardians()).seats[0].vacant).toBe(true);
    act(svc, "thabo");
    await svc.ownerReplaceSeat(estate, 0, NEW);
    expect((await guardians()).seats[0]).toMatchObject({ holder: NEW.wallet, vacant: false, generation: 2 });
    expect((await snap()).estate.verifiers[0]).toBe(NEW.wallet);
  });

  it("refuses the owner, anyone who already holds a place, and an empty wallet (DuplicateVerifier)", async () => {
    const { svc, estate, guardians } = await start("funded");
    await expect(svc.ownerReplaceSeat(estate, 2, { wallet: P("thabo").address, name: "Thabo" })).rejects.toThrow(/^DuplicateVerifier/);
    await expect(svc.ownerReplaceSeat(estate, 2, { wallet: P("nomsa").address, name: "Ndlovu" })).rejects.toThrow(/^DuplicateVerifier/);
    await expect(svc.ownerReplaceSeat(estate, 2, { wallet: P("busi").address, name: "Bongani" })).rejects.toThrow(/^DuplicateVerifier/);
    await expect(svc.ownerReplaceSeat(estate, 2, { wallet: "  ", name: "Nobody" })).rejects.toThrow(/^DuplicateVerifier/);
    await expect(svc.ownerReplaceSeat(estate, 2, { wallet: "11111111111111111111111111111111", name: "Nobody" })).rejects.toThrow(/^DuplicateVerifier/);
    expect((await guardians()).seats[2]).toMatchObject({ holder: P("busi").address, generation: 0 });
  });

  it("only the owner may do it, only while the estate is active, and only on a seat that exists", async () => {
    const { svc, estate } = await start("funded");
    for (const who of ["busi", "zodwa", "nomsa", "lerato"]) {
      act(svc, who);
      await expect(svc.ownerReplaceSeat(estate, 2, NEW)).rejects.toThrow(/^NotOwner/);
    }
    act(svc, "thabo");
    await expect(svc.ownerReplaceSeat(estate, 5, NEW)).rejects.toThrow(/^BadStatus/);
    const after = await start("guardians"); // Thabo has passed: the estate is unlocked
    await expect(after.svc.ownerReplaceSeat(after.estate, 2, NEW)).rejects.toThrow(/^BadStatus/);
  });

  it("needs guardians set up (no Seat accounts before)", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    act(svc, "thabo");
    const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
    await expect(svc.ownerReplaceSeat(estate, 2, NEW)).rejects.toThrow(/^BadStatus/);
  });
});
