/**
 * The spec sheet's zod schema (see ./spec for the sheet, its layouts and the media root). Apart from ./spec so the
 * browser pages that only display a sheet (the Assets screen, the gallery) do not load zod; the API, the services
 * and the spec editor import it from here.
 */
import { z } from "zod";
import { cleanSpec, CONDITION_CATEGORIES, CONDITIONS, DRIVES, FUELS, SERVICE_HISTORIES, TRANSMISSIONS, type AssetSpec } from "./spec";

const text = (max: number) => z.string().trim().min(1).max(max);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const dec = (max: number) => z.number().min(0).max(max).multipleOf(0.1);

/** Every field is optional: an owner fills what they know. Bounds are generous but stop nonsense. */
export const specSchema = z.object({
  // key facts
  mileageKm: int(0, 2_000_000).optional(),
  driveType: text(20).optional(),            // "4x2", "4x4"
  transmission: z.enum(TRANSMISSIONS).optional(),
  fuel: z.enum(FUELS).optional(),
  consumptionL100: dec(50).optional(),       // litres per 100 km
  engineCc: int(1, 10_000).optional(),
  // details
  make: text(40).optional(),
  model: text(40).optional(),
  variant: text(60).optional(),
  year: int(1900, 2100).optional(),
  bodyType: text(30).optional(),             // "Sedan", "Road bike"
  colour: text(30).optional(),
  seats: int(1, 60).optional(),
  doors: int(0, 10).optional(),
  // condition
  serviceHistory: z.enum(SERVICE_HISTORIES).optional(),
  conditionCategory: z.enum(CONDITION_CATEGORIES).optional(),
  spareKey: z.boolean().optional(),
  roadworthyNotes: text(400).optional(),
  // performance
  zeroTo100S: dec(60).optional(),
  topSpeedKmh: int(1, 500).optional(),
  powerKw: int(1, 2_000).optional(),
  fuelTankL: int(1, 500).optional(),
  cylinderLayout: text(20).optional(),       // "I4", "V6"
  gears: int(1, 12).optional(),
  drive: z.enum(DRIVES).optional(),
  // furniture, jewellery, electronics, other (15 Nov 2026: a spec sheet for every kind, each in its own form)
  brand: text(40).optional(),
  material: text(60).optional(),             // "Solid oak", "Leather"
  dimensionsCm: text(40).optional(),         // "180 x 90 x 76"
  weightKg: dec(10_000).optional(),
  pieces: int(1, 500).optional(),            // "a table and six chairs" = 7
  metal: text(30).optional(),                // "Yellow gold"
  purity: text(20).optional(),               // "18 ct", "925"
  weightG: dec(100_000).optional(),
  stones: text(120).optional(),              // "One 0.5 ct diamond"
  certificate: z.boolean().optional(),       // valuation or grading certificate
  keySpecs: text(200).optional(),            // "65-inch 4K, 3 HDMI"
  includes: text(200).optional(),            // "Remote, original box, charger"
  warrantyUntil: text(30).optional(),        // "March 2027"
  condition: z.enum(CONDITIONS).optional(),
  proofOfPurchase: z.boolean().optional(),
  knownFaults: text(400).optional(),
}).strict();

/** What the API and the services accept: blanks are dropped first (forms send ""), then the sheet is checked. */
export const specInputSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? cleanSpec(v as Record<string, unknown>) ?? {} : v),
  specSchema,
);

/** Cleans and validates a spec sheet (throws a ZodError on bad input); undefined when empty. */
export function parseSpec(raw: unknown): AssetSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  return cleanSpec(specInputSchema.parse(raw));
}

