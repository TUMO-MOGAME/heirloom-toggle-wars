/** Replacing a death, seat or fallback report (R4-R6), and no success before the network confirmed. */
import { describe, expect, it } from "vitest";
import { confirmableFrom, deathClaimStep, fallbackReportStep, seatReportStep } from "./chain-reports";
import { ChainServiceError, writeFailure } from "./chain-errors";

const NOBODY = "11111111111111111111111111111111";
const [A, B, RECIPIENT] = ["A", "B", "R"];
const hash = (n: number) => Array<number>(32).fill(n);
const hexOf = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const T = 1_000_000;

const estate = (over: Record<string, unknown> = {}) => ({
  status: { Active: {} }, waiting_period_secs: 120, verifiers: ["v", NOBODY, NOBODY],
  death_cert_hash: hash(7), death_verdict: { Pending: {} }, death_pending_since: T, death_submitted_by: A, last_heartbeat: 0, ...over,
});

describe("the owner's death claim", () => {
  it("none stands: send", () => expect(deathClaimStep(estate({ death_cert_hash: hash(0) }), B, hexOf(9), T)).toBe("send"));

  it("unreviewed: never replaced, by anyone; it waits for the agent's review", () => {
    expect(() => deathClaimStep(estate(), B, hexOf(9), T + 999_999)).toThrowError(expect.objectContaining({ code: "BadStatus", message: expect.stringMatching(/hasn't reviewed it/) }));
    expect(() => deathClaimStep(estate(), A, hexOf(9), T + 999_999)).toThrow(/^BadStatus/);
  });

  it("disproved (the owner showed life after it): replaced at once, also while DeathPending; never once unlocked", () => {
    expect(deathClaimStep(estate({ last_heartbeat: T + 1 }), A, hexOf(9), T + 2)).toBe("send");
    expect(deathClaimStep(estate({ last_heartbeat: T + 1, status: { DeathPending: {} } }), B, hexOf(9), T + 2)).toBe("send");
    expect(() => deathClaimStep(estate({ last_heartbeat: T + 1, status: { Unlocked: {} } }), B, hexOf(9), T + 2)).toThrow(/^BadStatus/);
    expect(() => deathClaimStep(estate({ last_heartbeat: T, status: { DeathPending: {} } }), B, hexOf(9), T + 2)).toThrow(/^BadStatus/);
  });

  it("reviewed: the person who made it waits one grace longer", () => {
    const e = estate({ death_verdict: { Approved: {} } });
    expect(deathClaimStep(e, B, hexOf(9), T + 240)).toBe("send");
    expect(() => deathClaimStep(e, A, hexOf(9), T + 359)).toThrow(ChainServiceError);
    expect(deathClaimStep(e, A, hexOf(9), T + 360)).toBe("send");
  });

  it("reviewed without a quorum: two waits", () => {
    const e = estate({ death_verdict: { Referred: {} } });
    expect(() => deathClaimStep(e, B, hexOf(9), T + 239)).toThrow(/^BadStatus/);
    expect(deathClaimStep(e, B, hexOf(9), T + 240)).toBe("send");
  });

  it("reviewed, with nobody left in a seat: it stands as the fallback's proof", () => {
    const e = estate({ death_verdict: { Approved: {} }, verifiers: [NOBODY, NOBODY, NOBODY] });
    expect(() => deathClaimStep(e, B, hexOf(9), T + 999_999)).toThrow(/^BadStatus/);
    expect(() => deathClaimStep(estate({ verifiers: [NOBODY, NOBODY, NOBODY] }), B, hexOf(9), T + 999_999)).toThrow(/^BadStatus/); // unreviewed: never
  });

  it("from before times were stored: disproved by any sign of life, so replaced at once", () => {
    expect(deathClaimStep(estate({ death_pending_since: 0, last_heartbeat: 5 }), B, hexOf(9), T)).toBe("send");
  });

  it("your own unreviewed report of the same file only asks for the review again", () => {
    expect(deathClaimStep(estate(), A, hexOf(7), T + 1)).toBe("resume");
    expect(() => deathClaimStep(estate(), B, hexOf(7), T + 1)).toThrow();
    expect(() => deathClaimStep(estate({ death_verdict: { Approved: {} } }), A, hexOf(7), T + 1)).toThrow();
  });

  it.each(["DeathPending", "Unlocked"])("nothing to report once %s", (status) => {
    expect(() => deathClaimStep(estate({ status: { [status]: {} } }), B, hexOf(9), T + 999_999)).toThrow(/^BadStatus/);
  });
});

describe("a seat's report", () => {
  const seat = (over: Record<string, unknown> = {}) => ({
    death_cert_hash: hash(7), death_verdict: { Approved: {} }, death_pending_since: T, death_reported_by: A, death_confirmed_by: NOBODY, ...over,
  });

  it("reviewed and unconfirmed: the recovery timeout and two waits (RT + 2W)", () => {
    expect(() => seatReportStep(estate(), seat(), B, hexOf(9), T + 719)).toThrow(/^SuccessionPending/);
    expect(seatReportStep(estate(), seat(), B, hexOf(9), T + 720)).toBe("send");
  });

  it("confirmed: never", () => {
    expect(() => seatReportStep(estate(), seat({ death_confirmed_by: B }), "C", hexOf(9), T + 999_999)).toThrow(/^SuccessionPending/);
  });

  it("none, and your own unreviewed one", () => {
    expect(seatReportStep(estate(), seat({ death_cert_hash: hash(0) }), B, hexOf(9), T)).toBe("send");
    expect(seatReportStep(estate(), seat({ death_verdict: { Pending: {} } }), A, hexOf(7), T)).toBe("resume");
  });
});

describe("a fallback recipient's report", () => {
  const guard = { fallback: [NOBODY, RECIPIENT, NOBODY, NOBODY], fallback_wait_secs: 500 };
  const report = (over: Record<string, unknown> = {}) => ({
    recipient: RECIPIENT, reporter: A, cert_hash: hash(7), verdict: { Approved: {} }, reported_at: T, ...over,
  });

  it("reviewed: twice the refute wait", () => {
    expect(() => fallbackReportStep(estate(), guard, 1, report(), B, hexOf(9), T + 999)).toThrow(/^BadStatus/);
    expect(fallbackReportStep(estate(), guard, 1, report(), B, hexOf(9), T + 1_000)).toBe("send");
  });

  it("void once the list names someone else there", () => {
    expect(fallbackReportStep(estate(), guard, 1, report({ recipient: "X" }), B, hexOf(9), T)).toBe("send");
    expect(fallbackReportStep(estate(), guard, 1, null, B, hexOf(9), T)).toBe("send");
  });

  it("confirmable after the refute wait, which is a minute at least", () => {
    expect(confirmableFrom(guard, report())).toBe(T + 500);
    expect(confirmableFrom({ ...guard, fallback_wait_secs: 0 }, report())).toBe(T + 60);
  });
});

describe("a write is a success only when confirmed (U1)", () => {
  const r = (status: "confirmed" | "pending" | "submitted" | "failed", error?: string, signature: string | undefined = "sig") => ({ status, error, signature });

  it("confirmed", () => expect(writeFailure(r("confirmed"))).toBeNull());
  it.each(["pending", "submitted"] as const)("%s is not: the claim may still stand", (status) => {
    expect(writeFailure(r(status))).toMatch(/^NotConfirmed: /);
  });
  it("a refusal in plain words", () => {
    expect(writeFailure(r("failed", 'The network rejected this payment ({"InstructionError":[0,{"Custom":6059}]}). Nothing was paid.'))).toMatch(/^DeathReportOpen: /);
  });
  it("anything else as it came", () => {
    expect(writeFailure(r("failed", "offline"))).toBe("offline");
    expect(writeFailure(null)).toBe("Transaction failed.");
  });
});
