import { describe, expect, it } from "vitest";
import { DEMO_FX, ESTIMATED_KINDS, estimateValuation } from "./mock-valuation";
import { valuationBody } from "../agent/schemas";
import { VALUED_KINDS } from "../media/api";
import { assets } from "@/content/assets";
import { screens } from "@/content/screens";

const corolla = { make: "Toyota", model: "Corolla 1.8 Exclusive CVT", year: 2017, mileageKm: 124_455, condition: "Good" };
const mustang = { make: "Big Boy", model: "Mustang 250", year: 2025, mileageKm: 199, condition: "Good", kind: "Motorbike" as const };
const hardshipOf = (low: number) => Math.round(low * 0.84 / 50) * 50; // what the add-asset form fills in

describe("demo valuation", () => {
  it("values Thabo's Corolla as before: 13,500 asking, 12,500 minimum", () => {
    for (const input of [corolla, { ...corolla, kind: "Car" as const }]) {
      const v = estimateValuation(input, DEMO_FX);
      expect([v.suggestedAskingUsdt, v.lowUsdt]).toEqual([13_500, 12_500]);
      expect(hardshipOf(v.lowUsdt)).toBe(10_500);
    }
  });

  it("values the Mustang 250 as a motorbike: 2,000 asking, 1,800 minimum, 1,500 hardship", () => {
    const v = estimateValuation(mustang, DEMO_FX);
    expect([v.suggestedAskingUsdt, v.lowUsdt, hardshipOf(v.lowUsdt)]).toEqual([2_000, 1_800, 1_500]);
    expect(v.highUsdt).toBeGreaterThan(v.suggestedAskingUsdt);
    expect(v.rationale).toMatch(/motorbikes/);
    for (const c of v.comparables) {
      expect(c.priceZar).toBeGreaterThan(30_000);
      expect(c.priceZar).toBeLessThan(40_000);
      expect(c.title).not.toMatch(/-\d/); // no negative mileage on a nearly new bike
    }
  });

  it("prices a motorbike far below a car, and an older or well-used bike lower again", () => {
    const bike = estimateValuation(mustang, DEMO_FX).suggestedAskingUsdt;
    expect(bike).toBeLessThan(estimateValuation(corolla, DEMO_FX).suggestedAskingUsdt / 4);
    const older = estimateValuation({ ...mustang, year: 2021, mileageKm: 15_000 }, DEMO_FX);
    expect(older.suggestedAskingUsdt).toBeLessThan(bike);
    expect(older.suggestedAskingUsdt).toBeGreaterThan(500);
    expect(estimateValuation({ ...mustang, condition: "Fair" }, DEMO_FX).suggestedAskingUsdt).toBeLessThan(bike);
    expect(estimateValuation({ ...mustang, condition: "Excellent" }, DEMO_FX).suggestedAskingUsdt).toBeGreaterThan(bike);
    // Never zero or negative, however old.
    expect(estimateValuation({ ...mustang, year: 1985, mileageKm: 400_000 }, DEMO_FX).lowUsdt).toBeGreaterThan(0);
  });

  it("has a price curve for every kind the form offers a valuation for, and the API accepts the kind", () => {
    for (const k of VALUED_KINDS) expect(ESTIMATED_KINDS).toContain(k);
    expect(valuationBody.safeParse(mustang).success).toBe(true);
    expect(valuationBody.safeParse({ ...mustang, kind: "Furniture" }).success).toBe(false);
  });

  it("starts the form at the demo vehicles' details", () => {
    const d = assets.add.motorbikeDefaults;
    expect(estimateValuation({ make: d.make, model: d.model, year: Number(d.year), mileageKm: Number(d.mileage), condition: "Good", kind: "Motorbike" }, DEMO_FX).suggestedAskingUsdt).toBe(2_000);
    const c = screens.car.register.defaults;
    expect(estimateValuation({ make: c.make, model: c.model, year: Number(c.year), mileageKm: Number(c.mileage), condition: "Good" }, DEMO_FX).suggestedAskingUsdt).toBe(13_500);
  });
});
