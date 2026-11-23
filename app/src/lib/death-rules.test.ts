import { describe, expect, it } from "vitest";
import {
  deciders, decidesAlone, eligibleSeats, fallbackGrace, isCurrentClaim, quorum, refuteWait, replaceableAt, reviewedHold, seatReviewedHold,
  unlockWaitSecs,
} from "./death-rules";

const [A, B, C] = ["A", "B", "C"];

describe("quorum", () => {
  const base = { verifiers: [A, B, C], votes: [true, false, false], threshold: 2, verdict: "Approved" as const };
  it("needs the threshold", () => expect(quorum(base)).toEqual({ needed: 2, got: 1, met: false }));
  it("falls to the living seats", () => expect(quorum({ ...base, verifiers: [A, null, null] }).met).toBe(true));
  it("a referral needs two", () => expect(quorum({ ...base, threshold: 1, verdict: "Referred" }).needed).toBe(2));
  it("nobody votes in their own favour", () => expect(quorum({ ...base, threshold: 1, interested: A }).met).toBe(false));
  it("zero eligible never passes", () => expect(quorum({ ...base, verifiers: [A, null, null], interested: A }).met).toBe(false));
  it("the all-zero key is an empty seat", () => expect(eligibleSeats(["11111111111111111111111111111111", B])).toEqual([1]));
  it("the only one left who gains decides alone, when the agent approved", () => {
    const lone = { ...base, verifiers: [A, null, null], interested: A, threshold: 1 };
    expect(quorum({ ...lone, alone: true }).met).toBe(true);
    expect(quorum({ ...lone, alone: true, verdict: "Referred" }).met).toBe(false);
    expect(quorum(lone).met).toBe(false); // a hardship has no lone route
    expect(deciders([A, B, null], A, "Approved")).toEqual([1]);
    expect(decidesAlone([A, null, null], A, "Approved")).toBe(true);
    expect(decidesAlone([A, B, null], A, "Approved")).toBe(false);
    expect(decidesAlone([A, null, null], A, "Referred")).toBe(false);
    expect(decidesAlone([null, null, null], A, "Approved")).toBe(false);
  });
  it("decided alone: the unlock waits twice the waiting period (read as at least a minute)", () => {
    expect(unlockWaitSecs({ waitingPeriodSecs: 120, death: { decidedAlone: true } })).toBe(240);
    expect(unlockWaitSecs({ waitingPeriodSecs: 0, death: {} })).toBe(60);
  });
});

describe("replaceable reports", () => {
  const base = { verdict: "Pending" as const, reportedAt: 1_000, reporter: A, who: B, waitingSecs: 120, hold: reviewedHold(120) };
  it("unreviewed: one grace", () => expect(replaceableAt(base)).toBe(1_120));
  it("the reporter waits one longer", () => expect(replaceableAt({ ...base, who: A })).toBe(1_240));
  it("reviewed: two waits", () => expect(replaceableAt({ ...base, verdict: "Approved" })).toBe(1_240));
  it("the grace is clamped", () => {
    expect(replaceableAt({ ...base, waitingSecs: 1 })).toBe(1_060);
    expect(replaceableAt({ ...base, waitingSecs: 9_999_999 })).toBe(87_400);
  });
  it("refuting always has a minute", () => expect(refuteWait(0)).toBe(60));
  it("a reviewed seat report stands for the recovery timeout and two waits", () => expect(seatReviewedHold(120)).toBe(720));
  it("an unreviewed fallback death report keeps its place for at most half the refute wait", () => {
    expect(fallbackGrace(3_600, 600)).toBe(300);
    expect(fallbackGrace(120, 86_400)).toBe(120);
    expect(replaceableAt({ ...base, grace: fallbackGrace(120, 100) })).toBe(1_050);
    expect(replaceableAt({ ...base, who: A, grace: fallbackGrace(120, 100) })).toBe(1_100);
  });
});

describe("reused rule slots", () => {
  it("tells a claim of the earlier rule apart", () => {
    expect(isCurrentClaim(3, 5)).toBe(true);
    expect(isCurrentClaim(3, 65_536)).toBe(false);
    expect(isCurrentClaim(65_536, 65_537)).toBe(true);
  });
});
