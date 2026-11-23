/**
 * POST /api/valuation's time budget (bug 7): the live search must answer inside the function limit, else the owner
 * gets Heirloom's own estimate (marked as one, with no example listings), never a silent 504.
 */
import { describe, expect, it, vi } from "vitest";
import { estimateOnly, valueCar } from "./valuation";
import type { CarValuation } from "../types";

const car = { make: "Toyota", model: "Corolla 1.8 Exclusive CVT", year: 2017, mileageKm: 98_000, condition: "Good" };
const fx = async () => ({ usdtZar: 18, source: "test" });
const live: CarValuation = { suggestedAskingUsdt: 13_000, lowUsdt: 12_000, highUsdt: 14_000, comparables: [{ title: "x", priceZar: 230_000, source: "y" }], rationale: "live" };

describe("valueCar time budget", () => {
  it("answers with the live valuation when it is in time", async () => {
    expect(await valueCar(car, { hasKey: () => true, fx, live: async () => live, budgetMs: 1000 })).toBe(live);
  });

  it("past the budget: the estimate, marked as one, without example listings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await valueCar(car, { hasKey: () => true, fx, live: () => new Promise(() => undefined), budgetMs: 20 });
    expect(out.estimate).toBe(true);
    expect(out.comparables).toEqual([]);
    expect(out.suggestedAskingUsdt).toBeGreaterThan(0);
    expect(out.lowUsdt).toBeLessThanOrEqual(out.suggestedAskingUsdt);
    expect(out).toEqual(estimateOnly(car, 18));
    warn.mockRestore();
  });

  it("a failed live valuation (agent error, 504 upstream) also falls back to the estimate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await valueCar(car, { hasKey: () => true, fx, live: async () => { throw new Error("timeout"); } });
    expect(out.estimate).toBe(true);
    warn.mockRestore();
  });

  it("the rate failing doesn't stop the valuation", async () => {
    const out = await valueCar(car, { hasKey: () => true, fx: async () => { throw new Error("VALR down"); }, live: async (_c, rate) => ({ ...live, rationale: rate.source }) });
    expect(out.rationale).toBe("demo rate");
  });

  it("without a key: the example figures, as before (not marked as a timed-out estimate)", async () => {
    const out = await valueCar(car, { hasKey: () => false });
    expect(out.estimate).toBeUndefined();
    expect(out.comparables.length).toBeGreaterThan(0);
  });
});
