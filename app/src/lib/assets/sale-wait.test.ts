/** What the car screen and the co-sign card say about an offer that can't be accepted yet (lib/assets/sale-wait.ts). */
import { describe, expect, it } from "vitest";
import type { Objection } from "../guardians/types";
import type { OfferRanking } from "../types";
import { bestWaiting, clockTime, nextReadyAt, offerWait } from "./sale-wait";

const ranking: OfferRanking = {
  bestOffer: null,
  eligible: [],
  ineligible: [
    { offer: "A", amount: 150n, reason: "Monitors can object", readyAt: 1060 },
    { offer: "B", amount: 150n, reason: "Monitors can object", readyAt: 1030 },
    { offer: "C", amount: 90n, reason: "Below the floor" },
    { offer: "OLD", amount: 200n, reason: "Made before an objection" },
  ],
};
const asset = { address: "CAR", hardshipBeneficiary: null };
const upheld: Objection = {
  address: "O", kind: "Sale", target: "CAR", monitor: "M", monitorName: "M", seatIndex: 0, reason: "", reasonHash: "", raisedAt: 900,
  status: "Upheld", votesUphold: 2, votesDismiss: 0,
};

describe("an offer that can't be accepted yet", () => {
  it("waits out its own objection window", () => {
    expect(offerWait(ranking, { address: "A", createdAt: 1000 }, { asset, windowSecs: 60 })).toEqual({ kind: "window", readyAt: 1060, why: "offer" });
  });

  it("or the hardship approval's, when that ends later", () => {
    const h = { asset: { address: "CAR", hardshipBeneficiary: "KID" }, windowSecs: 60 };
    expect(offerWait(ranking, { address: "A", createdAt: 950 }, h)).toEqual({ kind: "window", readyAt: 1060, why: "hardship" });
    expect(offerWait(ranking, { address: "A", createdAt: 1000 }, h)).toMatchObject({ why: "offer" });
  });

  it("is never accepted when made at or before an upheld objection to the sale", () => {
    expect(offerWait(ranking, { address: "OLD", createdAt: 900 }, { asset, objections: [upheld], windowSecs: 60 })).toEqual({ kind: "tooOld" });
    expect(offerWait(ranking, { address: "OLD", createdAt: 901 }, { asset, objections: [upheld], windowSecs: 60 })).toBeNull();
    expect(offerWait(ranking, { address: "OLD", createdAt: 900 }, { asset, objections: [{ ...upheld, status: "Dismissed" }], windowSecs: 60 })).toBeNull();
    expect(offerWait(ranking, { address: "C", createdAt: 1 }, { asset, objections: [upheld], windowSecs: 60 })).toEqual({ kind: "tooOld" });
  });

  it("an eligible or below-floor offer has no wait", () => {
    expect(offerWait(ranking, { address: "C", createdAt: 1000 }, { asset, windowSecs: 60 })).toBeNull();
    expect(offerWait(null, { address: "A", createdAt: 1000 }, { asset, windowSecs: 60 })).toBeNull();
  });

  it("the ranking is read again when the first window closes; the best waiting one is the highest, then the sooner", () => {
    expect(nextReadyAt(ranking)).toBe(1030);
    expect(nextReadyAt({ ...ranking, ineligible: [ranking.ineligible[2]] })).toBeNull();
    expect(bestWaiting(ranking)).toEqual({ offer: "B", amount: 150n, readyAt: 1030 });
    expect(bestWaiting({ bestOffer: null, eligible: [], ineligible: [] })).toBeNull();
  });

  it("from when, as a clock time rounded up to the minute, with the day when it isn't today", () => {
    const now = Math.floor(new Date(2026, 10, 23, 14, 5, 10).getTime() / 1000);
    expect(clockTime(now + 20, now, "en")).toBe("14:06");
    expect(clockTime(now + 50, now, "en")).toBe("14:06");
    expect(clockTime(now + 2 * 86_400, now, "en")).toMatch(/14:06/);
    expect(clockTime(now + 2 * 86_400, now, "en")).not.toBe("14:06");
    expect(clockTime(now + 20, now, "zu")).toMatch(/14.06/);
    expect(clockTime(now + 240 * 86_400, now, "en")).toMatch(/2027/); // a week or more away: the date
  });
});
