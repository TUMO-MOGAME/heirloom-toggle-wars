import "server-only";
/**
 * CarBroker valuation: Gemini with Google Search grounding finds public SA listings (ZAR), a second
 * structured call extracts comparables, then plain TS turns them into a USD₮ range with the live FX rate.
 */
import type { CarValuation } from "../types";
import { generate, generateJson, hasGemini } from "./gemini";
import { CAR_BROKER } from "./prompts";
import { comparablesSchema } from "./schemas";
import { cannedValuation } from "./canned";
import { getUsdtZar } from "../fx";
import type { AssetKind } from "../guardians/types";
import { DEMO_FX, estimateValuation } from "../service/mock-valuation";

export interface CarInput { make: string; model: string; year: number; mileageKm: number; condition: string; kind?: AssetKind }

/** Median-based range; trims outliers so one silly listing can't move the price much. */
export function summarize(pricesZar: number[], usdtZar: number): { suggested: number; low: number; high: number } {
  const p = [...pricesZar].filter((x) => x > 0).sort((a, b) => a - b);
  if (p.length === 0) throw new Error("No comparable prices found");
  const q = (f: number) => p[Math.min(p.length - 1, Math.max(0, Math.round(f * (p.length - 1))))];
  const toUsdt = (zar: number) => Math.round(zar / usdtZar / 50) * 50; // round to 50 USD₮
  return { suggested: toUsdt(q(0.5)), low: toUsdt(q(0.2)), high: toUsdt(q(0.8)) };
}

/**
 * The live valuation (two Gemini calls with search) must answer inside the function's time limit (60 s on the
 * hosting plan; a 504 reaches the owner as a blank failure). Past this budget the owner gets the estimate instead.
 */
export const VALUATION_BUDGET_MS = 45_000;

type Rate = { usdtZar: number; source: string };

export interface ValueCarDeps {
  budgetMs?: number;
  hasKey?: () => boolean;
  fx?: () => Promise<Rate>;
  live?: (car: CarInput, fx: Rate) => Promise<CarValuation>;
}

/**
 * The deterministic estimate (age, mileage and condition curves), marked as an estimate: no listings were checked,
 * so it carries no comparables (example listings would read as real ones).
 */
export function estimateOnly(car: CarInput, usdtZar: number): CarValuation {
  const e = estimateValuation(car, usdtZar);
  return {
    suggestedAskingUsdt: e.suggestedAskingUsdt, lowUsdt: e.lowUsdt, highUsdt: e.highUsdt, comparables: [], estimate: true,
    rationale: `Live listings could not be checked in time, so this is Heirloom's own estimate from the ${car.kind === "Motorbike" ? "motorbike" : "car"}'s age, mileage and condition. Your minimum price is yours to set; it is what the contract enforces.`,
  };
}

export async function valueCar(car: CarInput, deps: ValueCarDeps = {}): Promise<CarValuation> {
  const bike = car.kind === "Motorbike";
  // Without a key: the fixed car example, or for a motorbike the demo estimate (a Corolla's price would be absurd).
  const example = () => (bike ? estimateValuation(car, DEMO_FX) : cannedValuation());
  if (!(deps.hasKey ?? hasGemini)()) return example();
  const fx: Rate = await (deps.fx ?? getUsdtZar)().catch(() => ({ usdtZar: DEMO_FX, source: "demo rate" }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), deps.budgetMs ?? VALUATION_BUDGET_MS); });
  try {
    const out = await Promise.race([(deps.live ?? liveValuation)(car, fx), late]);
    if (out !== "late") return out;
    console.warn("[valuation] over the time budget; answering with the estimate");
  } catch (e) {
    console.warn(`[valuation] live valuation failed; answering with the estimate: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  return estimateOnly(car, fx.usdtZar);
}

/** Search for listings, extract comparables, then a USD₮ range at the live rate. */
async function liveValuation(car: CarInput, fx: Rate): Promise<CarValuation> {
  const bike = car.kind === "Motorbike";
  const example = () => (bike ? estimateValuation(car, DEMO_FX) : cannedValuation());
  const vehicle = bike ? "used motorbike" : "used-car";
  const query = `${car.year} ${car.make} ${car.model}, about ${car.mileageKm.toLocaleString("en-ZA")} km, condition: ${car.condition || "good"}`;

  const searched = await generate({
    system: CAR_BROKER,
    thinking: "low",
    timeoutMs: 45_000,
    config: { tools: [{ googleSearch: {} }] },
    contents: [{ role: "user", parts: [{ text: `Find 4-8 current ${vehicle} listings in South Africa for: ${query}. For each give title, asking price in rand, the site, and the URL.` }] }],
  });
  const sources = (searched.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web).filter((w): w is { uri?: string; title?: string } => Boolean(w?.uri));

  const parsed = await generateJson(comparablesSchema, {
    system: `Extract ${vehicle} comparables from the research notes. Use only prices explicitly stated in rand. Do not invent listings.`,
    thinking: "low",
    contents: [{ role: "user", parts: [{ text: `${bike ? "Motorbike" : "Car"}: ${query}\n\nResearch notes:\n${searched.text ?? ""}\n\nSource URLs:\n${sources.map((s) => `${s.title ?? ""} ${s.uri}`).join("\n")}` }] }],
  });

  if (parsed.comparables.length === 0) {
    const fallback = example();
    return { ...fallback, rationale: `No live listings could be confirmed, so these are example figures. ${fallback.rationale}` };
  }
  const s = summarize(parsed.comparables.map((c) => c.priceZar), fx.usdtZar);
  return {
    suggestedAskingUsdt: s.suggested, lowUsdt: s.low, highUsdt: s.high,
    comparables: parsed.comparables,
    rationale: `${parsed.rationale} Converted at R${fx.usdtZar.toFixed(2)} per USD₮ (${fx.source}). The owner's floor price still binds.`,
  };
}
