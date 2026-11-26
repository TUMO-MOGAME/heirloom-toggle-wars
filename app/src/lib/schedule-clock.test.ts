/** H10: a schedule's real interval is said before signing, in the summary and on each rule. M5: the wait as signed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clockOf, clockText, REAL_SECS, ruleClock, scheduleSecs } from "./schedule-clock";
import { intervalSecs } from "./agent/schemas";
import { waitingSecsFor } from "./will-summary";
import { intervalOf } from "./everyday/templates";
import { screens } from "../content/screens";
import type { Recurrence } from "./types";

const EVERY: Recurrence[] = ["minute", "week", "month", "term", "year"];
afterEach(() => vi.unstubAllEnvs());

describe("scheduleSecs", () => {
  it.each([[undefined], [""], ["60"], ["3600"]])("the chain service signs the same interval (env %j)", (env) => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_INTERVAL_SECS", env as string);
    for (const e of EVERY) expect(scheduleSecs(e, "chain")).toBe(intervalSecs(e));
  });
  it("ready-made bills sign what the plan shows", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_INTERVAL_SECS", "60");
    expect(intervalOf("month", false)).toBe(60);
    expect(intervalOf("month", true)).toBe(60);
  });
});

describe("clockText", () => {
  const w = screens.will.preview;
  it("says the test site's clock and what it stands for", () => {
    expect(clockText(clockOf(60, "month"), w)).toBe("Every 60 seconds on this test site; a month in real use.");
    expect(clockText(clockOf(REAL_SECS.month, "month"), w)).toBeNull();
  });
  it("a signed rule without its choice says only the clock", () => {
    expect(clockText(ruleClock({ intervalSecs: 60 }), w)).toBe("Every 60 seconds on this test site.");
    expect(clockText(ruleClock({ intervalSecs: REAL_SECS.year }), w)).toBeNull();
  });
});

describe("M5: the wait as it will be signed", () => {
  it("a 0-day wait is the shortest a new estate may sign, 300 seconds (plan §22.1 P1)", () => expect(waitingSecsFor(0, "chain", undefined)).toBe(300));
});
