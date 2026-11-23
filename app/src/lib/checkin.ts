/**
 * The owner's check-in ("I'm still here", the dead man's switch of plan.md U8).
 *
 * On-chain, `heartbeat` only records `last_heartbeat` (docs/program-spec.md #8); the contract has no check-in
 * interval and nothing starts the passing process on its own when a check-in is missed. So the interval below is
 * the app's plan: when it runs out, the owner is shown as overdue and the trusted people are asked to check on
 * them. A passing is still only established the usual way: a family member reports it with a certificate, the
 * agent reviews it and the trusted people confirm it on-chain.
 */
import type { Estate } from "./types";

/** The owner is asked to check in at least this often. */
export const CHECK_IN_EVERY_DAYS = 90;
/** The gentle reminder starts this many days before a check-in is due. */
export const CHECK_IN_REMIND_DAYS = 21;
/** Same as the mock's demo clock (lib/service/mock.ts DEMO_SECONDS_PER_DAY): in the demo a day lasts 2 seconds. */
export const DEMO_CHECK_IN_SECONDS_PER_DAY = 2;

export interface CheckInPlan {
  everyDays: number;
  remindDays: number;
  /** Real seconds per plan day: 86 400 on a network, 2 on the demo clock. */
  secsPerDay: number;
}

export function checkInPlan(mode: "mock" | "chain"): CheckInPlan {
  return { everyDays: CHECK_IN_EVERY_DAYS, remindDays: CHECK_IN_REMIND_DAYS, secsPerDay: mode === "mock" ? DEMO_CHECK_IN_SECONDS_PER_DAY : 86400 };
}

/**
 * - `ok`: checked in recently;
 * - `soon`: the reminder window (due within `remindDays`);
 * - `overdue`: the interval has run out, the trusted people are asked to check on the owner;
 * - `never`: no check-in recorded yet (treated as due now);
 * - `off`: the switch does not apply (a passing is already reported, or the estate has unlocked or is frozen).
 */
export type CheckInState = "ok" | "soon" | "overdue" | "never" | "off";

export interface CheckInStatus {
  state: CheckInState;
  /** Unix seconds when the next check-in is due (null when never checked in or off). */
  dueAt: number | null;
  /** Whole plan days since the last check-in (0 = today). */
  daysSince: number;
  /** Whole plan days until due, rounded up (0 = due now; negative = days overdue). */
  daysLeft: number;
  /** How much of the interval has passed, 0..1. */
  elapsed: number;
}

export function checkInStatus(estate: Pick<Estate, "status" | "lastHeartbeat" | "death">, now: number, plan: CheckInPlan): CheckInStatus {
  const reported = !!estate.death.certHash;
  if (estate.status !== "Active" || reported) return { state: "off", dueAt: null, daysSince: 0, daysLeft: 0, elapsed: 0 };
  if (!estate.lastHeartbeat || estate.lastHeartbeat <= 0) return { state: "never", dueAt: null, daysSince: 0, daysLeft: 0, elapsed: 1 };
  const span = plan.everyDays * plan.secsPerDay;
  const dueAt = estate.lastHeartbeat + span;
  const since = Math.max(0, now - estate.lastHeartbeat);
  const left = dueAt - now;
  const daysSince = Math.floor(since / plan.secsPerDay);
  const daysLeft = left > 0 ? Math.ceil(left / plan.secsPerDay) : -Math.floor(-left / plan.secsPerDay);
  const elapsed = Math.min(1, since / span);
  const state: CheckInState = left <= 0 ? "overdue" : left <= plan.remindDays * plan.secsPerDay ? "soon" : "ok";
  return { state, dueAt, daysSince, daysLeft, elapsed };
}

/** Moves the last check-in back so that `daysLeft` plan days remain (demo shortcut; may be negative = overdue). */
export function heartbeatFor(daysLeft: number, now: number, plan: CheckInPlan): number {
  return now - (plan.everyDays - daysLeft) * plan.secsPerDay;
}
