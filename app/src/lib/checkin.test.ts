/** The owner's check-in (U8): the app's interval rules, and the mock's heartbeat, which mirrors the contract's. */
import { describe, expect, it } from "vitest";
import { CHECK_IN_EVERY_DAYS, CHECK_IN_REMIND_DAYS, DEMO_CHECK_IN_SECONDS_PER_DAY, checkInPlan, checkInStatus, heartbeatFor } from "./checkin";
import { createMockService, DEMO_PERSONAS, DEMO_SECONDS_PER_DAY, type DemoStage } from "./service/mock";
import type { Estate } from "./types";

const DAY = 86400;
const NOW = 1_800_000_000;
const chain = checkInPlan("chain");
const est = (over: Partial<Pick<Estate, "status" | "lastHeartbeat">> & { cert?: string | null } = {}) => ({
  status: over.status ?? "Active",
  lastHeartbeat: over.lastHeartbeat ?? NOW,
  death: { certHash: over.cert ?? null, submittedBy: null, verdict: "Pending" as const, attestations: [false, false, false], pendingSince: null },
});

describe("checkInStatus", () => {
  it("is ok right after a check-in, due in the full interval", () => {
    const st = checkInStatus(est(), NOW, chain);
    expect(st).toMatchObject({ state: "ok", daysSince: 0, daysLeft: CHECK_IN_EVERY_DAYS, dueAt: NOW + CHECK_IN_EVERY_DAYS * DAY, elapsed: 0 });
  });

  it("stays ok until the reminder window, then turns to the gentle reminder", () => {
    const before = NOW - (CHECK_IN_EVERY_DAYS - CHECK_IN_REMIND_DAYS - 1) * DAY;
    expect(checkInStatus(est({ lastHeartbeat: before }), NOW, chain).state).toBe("ok");
    const inside = NOW - (CHECK_IN_EVERY_DAYS - CHECK_IN_REMIND_DAYS) * DAY;
    expect(checkInStatus(est({ lastHeartbeat: inside }), NOW, chain)).toMatchObject({ state: "soon", daysLeft: CHECK_IN_REMIND_DAYS });
  });

  it("is overdue once the interval has run out, counting the days late", () => {
    expect(checkInStatus(est({ lastHeartbeat: NOW - CHECK_IN_EVERY_DAYS * DAY }), NOW, chain)).toMatchObject({ state: "overdue", daysLeft: 0, elapsed: 1 });
    const st = checkInStatus(est({ lastHeartbeat: NOW - (CHECK_IN_EVERY_DAYS + 5) * DAY - 10 }), NOW, chain);
    expect(st).toMatchObject({ state: "overdue", daysLeft: -5, daysSince: CHECK_IN_EVERY_DAYS + 5 });
  });

  it("treats a missing heartbeat as never checked in", () => {
    expect(checkInStatus(est({ lastHeartbeat: 0 }), NOW, chain)).toMatchObject({ state: "never", dueAt: null });
  });

  it("is off once a passing is reported, or the estate is past Active", () => {
    expect(checkInStatus(est({ cert: "ab".repeat(32) }), NOW, chain).state).toBe("off");
    for (const status of ["DeathPending", "Unlocked", "Frozen"] as const) expect(checkInStatus(est({ status, lastHeartbeat: 1 }), NOW, chain).state).toBe("off");
  });

  it("the demo plan runs on the mock's demo clock", () => {
    expect(DEMO_CHECK_IN_SECONDS_PER_DAY).toBe(DEMO_SECONDS_PER_DAY);
    const demo = checkInPlan("mock");
    expect(checkInStatus(est({ lastHeartbeat: NOW - 10 * DEMO_SECONDS_PER_DAY }), NOW, demo)).toMatchObject({ state: "ok", daysSince: 10, daysLeft: CHECK_IN_EVERY_DAYS - 10 });
  });

  it("heartbeatFor places the last check-in so that exactly n days remain", () => {
    for (const n of [CHECK_IN_REMIND_DAYS - 7, 0, -3]) expect(checkInStatus(est({ lastHeartbeat: heartbeatFor(n, NOW, chain) }), NOW, chain).daysLeft).toBe(n);
  });
});

/* ---------- the mock's rules (same checks as the program's `heartbeat`) ---------- */

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const act = (svc: Svc, key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };
async function start(stage: DemoStage) {
  const svc = createMockService({ instant: true });
  svc.resetDemo(stage);
  act(svc, "thabo");
  const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
  return { svc, estate, snap: () => svc.getEstate(estate) };
}
const nowSecs = () => Math.floor(Date.now() / 1000);
const demo = checkInPlan("mock");

describe("mock heartbeat", () => {
  it("the owner's check-in records the time and a receipt on the timeline", async () => {
    const { svc, estate, snap } = await start("funded");
    svc.setCheckInDaysLeft(-3);
    expect(checkInStatus((await snap()).estate, nowSecs(), demo).state).toBe("overdue");
    const t = await svc.heartbeat(estate);
    const s = await snap();
    expect(checkInStatus(s.estate, nowSecs(), demo).state).toBe("ok");
    expect(s.activity[0]).toMatchObject({ kind: "Heartbeat", txSignature: t.signature });
  });

  it("only the owner can check in", async () => {
    const { svc, estate } = await start("funded");
    act(svc, "lerato");
    await expect(svc.heartbeat(estate)).rejects.toThrow(/^NotOwner/);
    act(svc, "nomsa");
    await expect(svc.heartbeat(estate)).rejects.toThrow(/^NotOwner/);
  });

  it("works while a passing is pending (Active or DeathPending), refused once unlocked", async () => {
    const pending = await start("funded");
    pending.svc.simulatePassing();
    expect((await pending.snap()).estate.status).toBe("DeathPending");
    await expect(pending.svc.heartbeat(pending.estate)).resolves.toBeTruthy();
    const unlocked = await start("unlocked");
    await expect(unlocked.svc.heartbeat(unlocked.estate)).rejects.toThrow(/^BadStatus/);
  });

  it("refuses without an estate", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("fresh");
    act(svc, "thabo");
    await expect(svc.heartbeat("x")).rejects.toThrow(/^NoEstate/);
    expect(() => svc.setCheckInDaysLeft(5)).toThrow(/^NoEstate/);
  });

  it("the demo shortcut moves only the clock: the reminder, then overdue; refused after unlock", async () => {
    const { svc, snap } = await start("funded");
    const before = (await snap()).activity.length;
    svc.setCheckInDaysLeft(CHECK_IN_REMIND_DAYS - 7);
    expect(checkInStatus((await snap()).estate, nowSecs(), demo).state).toBe("soon");
    svc.setCheckInDaysLeft(-3);
    expect(checkInStatus((await snap()).estate, nowSecs(), demo).state).toBe("overdue");
    expect((await snap()).activity.length).toBe(before);
    const unlocked = await start("unlocked");
    expect(() => unlocked.svc.setCheckInDaysLeft(5)).toThrow(/^BadStatus/);
  });
});
