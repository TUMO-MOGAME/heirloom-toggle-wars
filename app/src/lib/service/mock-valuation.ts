/**
 * The demo valuation (mock mode, and the server's fallback for non-car vehicles without a Gemini key). Each kind that
 * offers a valuation (lib/media/api.ts VALUED_KINDS) has its own price curve, anchored on Thabo's demo assets:
 * - Car: the 2017 Corolla 1.8 Exclusive at 124,455 km asks about 13,500 USD₮, minimum 12,500;
 * - Motorbike: the 2025 Big Boy Mustang 250 at 199 km asks about 2,000 USD₮, minimum 1,800 (hardship 1,500 is set
 *   by the form: minimum x 0.84).
 * Prices are worked out in rand (like the listings) and converted at `fx` rand per USD₮.
 */
import type { CarValuation } from "../types";
import type { AssetKind } from "../guardians/types";

/** The demo's fixed exchange rate, rand per USD₮. */
export const DEMO_FX = 17.85;

export interface ValuationInput { make: string; model: string; year: number; mileageKm: number; condition: string; kind?: AssetKind }

interface Curve {
  /** Rand value of the anchor at its year and mileage. */
  anchorZar: number; anchorYear: number; anchorKm: number;
  /** Rand per model year newer (cars) or the share kept per year older (bikes lose value faster, as a percentage). */
  perYearZar?: number; keepPerYear?: number;
  /** Rand per km below (or above) the anchor's mileage. */
  perKmZar: number;
  /** The lowest value the curve returns, in rand. */
  minZar: number;
  /** Asking price / minimum price ratio the demo plan uses. */
  askToMin: number;
  /** Comparables: mileage offsets and where they are advertised. */
  km: [number, number, number];
  sources: [string, string, string];
  noun: string;
}

const CURVES: Partial<Record<AssetKind, Curve>> = {
  Car: {
    anchorZar: 241_000, anchorYear: 2017, anchorKm: 124_455, perYearZar: 12_000, perKmZar: 0.22, minZar: 60_000, askToMin: 1.08,
    km: [9_000, -14_000, 2_000], sources: ["AutoTrader · demo example", "Cars.co.za · demo example", "WeBuyCars · demo example"], noun: "",
  },
  Motorbike: {
    // A new small commuter bike: about R 35,700, losing about 12% a year and R 0.60 a km.
    anchorZar: 35_700, anchorYear: 2025, anchorKm: 199, keepPerYear: 0.88, perKmZar: 0.6, minZar: 5_000, askToMin: 1.11,
    km: [1_800, -150, 600], sources: ["AutoTrader Bikes · demo example", "Gumtree · demo example", "Bikers Corner · demo example"], noun: " motorbike",
  },
};

/** The kinds this estimate can value. Anything else (or no kind) is valued as a car, as before. */
export const ESTIMATED_KINDS = Object.keys(CURVES) as AssetKind[];

const fiftyUsdt = (usdt: number) => Math.round(usdt / 50) * 50;

export function estimateValuation(input: ValuationInput, fx: number): CarValuation {
  const { make, model, year, mileageKm, condition } = input;
  const c = CURVES[input.kind ?? "Car"] ?? CURVES.Car!;
  const cond = /excellent/i.test(condition) ? 1.04 : /fair|poor/i.test(condition) ? 0.9 : 1;
  const age = year - c.anchorYear;
  const byYear = c.keepPerYear !== undefined ? c.anchorZar * c.keepPerYear ** -age : c.anchorZar + age * (c.perYearZar ?? 0);
  const baseZar = Math.max(c.minZar, (byYear + (c.anchorKm - mileageKm) * c.perKmZar) * cond);
  const round = (z: number) => Math.round(z / 100) * 100 - 100;
  const mid = fiftyUsdt(baseZar / fx);
  const km = (d: number) => Math.max(0, mileageKm + d).toLocaleString("en-ZA");
  const what = `${make} ${model}`.trim();
  const [lo, hi] = [round(baseZar * 0.97), round(baseZar * 1.05)];
  return {
    // The low end is the minimum the plan uses with this asking price: 13,500 -> 12,500 for the car, 2,000 -> 1,800 for the bike.
    suggestedAskingUsdt: mid, lowUsdt: fiftyUsdt(mid / c.askToMin), highUsdt: fiftyUsdt(mid * 1.06),
    comparables: [
      { title: `${year} ${what}, ${km(c.km[0])} km, Johannesburg`, priceZar: lo, source: c.sources[0] },
      { title: `${year} ${what}, ${km(c.km[1])} km, Pretoria`, priceZar: hi, source: c.sources[1] },
      { title: `${year + 1} ${what}, ${km(c.km[2])} km, Soweto`, priceZar: round(baseZar * 1.02), source: c.sources[2] },
    ],
    rationale: `Three similar ${what}${c.noun}s are advertised between R ${lo.toLocaleString("en-ZA")} and R ${hi.toLocaleString("en-ZA")}. Private sales usually close a little under the advertised price, so a fair asking price is about ${mid.toLocaleString("en-ZA")} USD₮. Your minimum price is yours to set; it is what the contract enforces.`,
  };
}
