import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN, GUIDED_STEPS, checkPlan, clockText, elapsedMs, failStep, finishStep, initialState, interrupted, isFinished,
  nextStep, overCapAmount, parseState, progress, setPlan, startStep, stepOf,
} from "./machine";

describe("guided run state machine", () => {
  it("runs the eleven steps in order, one at a time", () => {
    let s = initialState("mock");
    expect(nextStep(s)).toBe("wallet");
    expect(() => startStep(s, "money", 1)).toThrow(/not next/);
    s = startStep(s, "wallet", 1000);
    expect(() => startStep(s, "wallet", 1001)).toThrow();
    s = finishStep(s, "wallet", { patch: { owner: "Owner1111111111111111111111111111" } }, 2000);
    expect(s.owner).toBe("Owner1111111111111111111111111111");
    expect(nextStep(s)).toBe("money");
    for (const id of GUIDED_STEPS.slice(1)) {
      s = startStep(s, id, 3000);
      s = finishStep(s, id, { txs: [{ signature: `sig-${id}`, explorerUrl: `https://explorer.solana.com/tx/sig-${id}?cluster=devnet` }] }, 5000);
    }
    expect(isFinished(s)).toBe(true);
    expect(s.finishedAt).toBe(5000);
    expect(elapsedMs(s, 99_999)).toBe(4000);
    expect(progress(s)).toEqual({ done: 11, total: 11 });
  });

  it("keeps a failure with its reason, and runs the same step again on retry", () => {
    let s = startStep(initialState("chain"), "wallet", 0);
    s = failStep(s, "wallet", { code: "rateLimited", message: "429 Too Many Requests" }, 10);
    expect(stepOf(s, "wallet")).toMatchObject({ status: "failed", error: { code: "rateLimited" } });
    expect(nextStep(s)).toBe("wallet");
    s = startStep(s, "wallet", 20);
    expect(stepOf(s, "wallet").error).toBeUndefined();
    expect(s.startedAt).toBe(0); // the run's clock starts once
  });

  it("marks a step that was running when the page closed as interrupted", () => {
    const s = interrupted(startStep(initialState("chain"), "wallet", 0), 50);
    expect(stepOf(s, "wallet")).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(interrupted(initialState("chain"), 1)).toEqual(initialState("chain"));
  });

  it("lets the plan change only before it is signed", () => {
    let s = initialState("mock");
    s = setPlan(s, { ...DEFAULT_PLAN, perClaim: 60 });
    expect(s.plan.perClaim).toBe(60);
    for (const id of ["wallet", "money", "plan"] as const) s = finishStep(startStep(s, id, 0), id, {}, 1);
    expect(() => setPlan(s, DEFAULT_PLAN)).toThrow(/already signed/);
  });

  it("checks the plan's numbers before anything is signed", () => {
    expect(checkPlan(DEFAULT_PLAN, "chain")).toBeNull();
    expect(checkPlan({ ...DEFAULT_PLAN, perClaim: 0 }, "mock")).toBe("whole");
    expect(checkPlan({ ...DEFAULT_PLAN, claim: 2.5 }, "mock")).toBe("whole");
    expect(checkPlan({ ...DEFAULT_PLAN, perClaim: 300 }, "mock")).toBe("perClaimOverTotal");
    expect(checkPlan({ ...DEFAULT_PLAN, claim: 51 }, "mock")).toBe("claimOverCap");
    expect(checkPlan({ ...DEFAULT_PLAN, deposit: 30 }, "mock")).toBe("depositBelowClaim");
    expect(checkPlan({ ...DEFAULT_PLAN, deposit: 600, total: 900 }, "chain")).toBe("depositOverStarter");
    expect(checkPlan({ ...DEFAULT_PLAN, deposit: 600, total: 900 }, "mock")).toBeNull();
    expect(overCapAmount(DEFAULT_PLAN)).toBeGreaterThan(DEFAULT_PLAN.perClaim);
  });

  it("reads back only a saved run of the same kind of site", () => {
    const s = initialState("chain");
    expect(parseState(JSON.stringify(s), "chain")).toEqual(s);
    expect(parseState(JSON.stringify(s), "mock")).toBeNull();
    expect(parseState("{oops", "chain")).toBeNull();
    expect(parseState(JSON.stringify({ ...s, steps: s.steps.slice(1) }), "chain")).toBeNull();
    expect(parseState(null, "chain")).toBeNull();
  });

  it("writes the time like a clock", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(65_400)).toBe("1:05");
    expect(clockText(3_723_000)).toBe("1:02:03");
  });
});
