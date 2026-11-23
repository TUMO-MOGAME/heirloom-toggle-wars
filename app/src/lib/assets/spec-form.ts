/**
 * The spec sheet edit form's model: every field as text (what the inputs hold) and back. Accepts South African
 * number input: spaces or commas as thousands separators in whole numbers ("124 455"), and a decimal comma in
 * one-decimal fields ("6,4").
 */
import {
  CONDITION_CATEGORIES, CONDITIONS, DRIVES, FUELS, SERVICE_HISTORIES, specKeysFor, TRANSMISSIONS,
  type AssetSpec, type SpecKey,
} from "./spec";
import { specInputSchema, specSchema } from "./spec-schema";
import { parseAmount } from "../amount";
import type { AssetKind } from "../guardians/types";

export type SpecDraft = Record<SpecKey, string>;

export const INT_FIELDS: readonly SpecKey[] = ["mileageKm", "engineCc", "year", "seats", "doors", "topSpeedKmh", "powerKw", "fuelTankL", "gears", "pieces"];
export const DECIMAL_FIELDS: readonly SpecKey[] = ["consumptionL100", "zeroTo100S", "weightKg", "weightG"];
export const BOOLEAN_FIELDS: readonly SpecKey[] = ["spareKey", "certificate", "proofOfPurchase"];
export const CHOICES: Partial<Record<SpecKey, readonly string[]>> = {
  transmission: TRANSMISSIONS, fuel: FUELS, serviceHistory: SERVICE_HISTORIES, conditionCategory: CONDITION_CATEGORIES, drive: DRIVES,
  condition: CONDITIONS, ...Object.fromEntries(BOOLEAN_FIELDS.map((k) => [k, ["yes", "no"]])),
};
export const LONG_TEXT_FIELDS: readonly SpecKey[] = ["roadworthyNotes", "knownFaults"];

/** Every field, in the schema's order (used for error order). */
const ALL_KEYS = Object.keys(specSchema.shape) as SpecKey[];

export function specToDraft(spec?: AssetSpec): SpecDraft {
  const out = {} as SpecDraft;
  for (const k of ALL_KEYS) {
    const v = spec?.[k];
    out[k] = v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  }
  return out;
}

/**
 * Text → spec sheet. Returns the keys that are not valid (empty list = ok); blanks are left out. With `kind`, only
 * that kind's fields are read (a draft typed as a car and then switched to furniture keeps no mileage).
 */
export function draftToSpec(draft: Partial<SpecDraft>, kind?: AssetKind): { spec?: AssetSpec; invalid: SpecKey[] } {
  const raw: Record<string, unknown> = {};
  const invalid = new Set<SpecKey>();
  const keys = kind ? new Set(specKeysFor(kind)) : null;
  for (const k of ALL_KEYS) {
    if (keys && !keys.has(k)) continue;
    const t = (draft[k] ?? "").trim();
    if (!t) continue;
    if (INT_FIELDS.includes(k)) {
      const p = parseAmount(t);
      const n = p !== null && Number.isInteger(p) ? p : Number.NaN;
      if (Number.isFinite(n)) raw[k] = n; else invalid.add(k);
    } else if (DECIMAL_FIELDS.includes(k)) {
      const n = parseAmount(t) ?? Number.NaN;
      if (Number.isFinite(n)) raw[k] = n; else invalid.add(k);
    } else if (BOOLEAN_FIELDS.includes(k)) {
      raw[k] = t === "yes";
    } else {
      raw[k] = t;
    }
  }
  const parsed = specInputSchema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) if (typeof issue.path[0] === "string") invalid.add(issue.path[0] as SpecKey);
  if (invalid.size) return { invalid: ALL_KEYS.filter((k) => invalid.has(k)) };
  const data = parsed.data ?? {};
  return { spec: Object.keys(data).length ? data : undefined, invalid: [] };
}

/** A starting draft for a new vehicle from the valuation fields the owner already typed. */
export function draftFromVehicle(v: { make?: string; model?: string; year?: string; mileage?: string }): SpecDraft {
  return { ...specToDraft(), make: v.make ?? "", model: v.model ?? "", year: v.year ?? "", mileageKm: v.mileage ?? "" };
}
