/**
 * How often a schedule really repeats, and when that is not what the owner chose (plan §18.9 H10). The demo runs
 * every schedule each 60 seconds, and the devnet site sets NEXT_PUBLIC_DEMO_INTERVAL_SECS, so a "monthly" payment is
 * signed with a 60-second interval there. The plan must say so before it is signed, in its summary and on each rule.
 * Pure (lib/agent/schemas.ts intervalSecs is the same rule for the chain service; a test keeps them equal).
 */
import type { Recurrence, Rule } from "./types";

export const REAL_SECS: Record<Recurrence, number> = { minute: 60, week: 7 * 86_400, month: 30 * 86_400, term: 91 * 86_400, year: 365 * 86_400 };
/** The demo's clock (mock): every schedule repeats each minute. */
export const DEMO_INTERVAL_SECS = 60;

/** The interval a schedule chosen as `every` gets when it is signed here. */
export function scheduleSecs(every: Recurrence, mode: "mock" | "chain", demoEnv: string | undefined = process.env.NEXT_PUBLIC_DEMO_INTERVAL_SECS): number {
  if (mode === "mock") return DEMO_INTERVAL_SECS;
  const demo = demoEnv === undefined || demoEnv.trim() === "" ? NaN : Number(demoEnv);
  return Number.isFinite(demo) && demo > 0 ? demo : REAL_SECS[every];
}

export interface Clock {
  /** The interval differs from what was chosen (or, unknown, is shorter than a day): say it in seconds. */
  fast: boolean;
  secs: number;
  /** What the owner chose, when known. */
  every?: Recurrence;
}

export function clockOf(secs: number, every?: Recurrence): Clock {
  return { fast: every ? secs !== REAL_SECS[every] : secs < 86_400, secs, ...(every ? { every } : {}) };
}

/** A signed rule's clock: the interval on-chain, and the choice when this device or the demo knows it. */
export const ruleClock = (r: Pick<Rule, "intervalSecs" | "every">) => clockOf(r.intervalSecs, r.every);

export interface ClockWords {
  /** "Every {secs} seconds on this test site; {real} in real use." */
  clock: string;
  /** "Every {secs} seconds on this test site." */
  clockOnly: string;
  real: Record<Recurrence, string>;
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/** The sentence for a fast clock, or null when the schedule keeps the interval that was chosen. */
export function clockText(c: Clock, w: ClockWords): string | null {
  if (!c.fast) return null;
  return c.every ? fill(w.clock, { secs: c.secs, real: w.real[c.every] }) : fill(w.clockOnly, { secs: c.secs });
}
