import { dailyCap, handler, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { valuationBody } from "@/lib/agent/schemas";
import { valueCar } from "@/lib/agent/valuation";

export const maxDuration = 90;

/** POST /api/valuation { make, model, year, mileageKm, condition } → CarValuation (CarBroker, Search grounding). */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "valuation", 6);
  const car = await parseJson(req, valuationBody);
  await dailyCap(req, "search");
  return json(await valueCar(car));
});
