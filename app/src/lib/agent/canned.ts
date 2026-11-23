/**
 * Clearly-labelled canned answers used when GEMINI_API_KEY is not set, so the demo still runs end to end.
 * Every text starts with CANNED_PREFIX so nobody mistakes it for a live model answer.
 */
import type { CarValuation, WillDraft } from "../types";
import type { ModelReport } from "./schemas";

export const CANNED_PREFIX = "[Demo answer: AI not configured] ";

/**
 * The will seeded on devnet (scripts/seed-demo.ts, scripts/seed-guardians-assets.ts hash it into will_hash), so its
 * text must stay as it was signed: short names included. The app shows `CANNED_WILL`, the same will with the trusted
 * people's full names, as on every other screen (lib/names: full name in lists, short form in sentences).
 */
export const DEMO_WILL: WillDraft = {
  ownerName: "Thabo Mokoena",
  beneficiaries: [
    { label: "Lerato (daughter)", relationship: "daughter" },
    { label: "Sipho (son)", relationship: "son" },
    { label: "Naledi (daughter)", relationship: "daughter" },
  ],
  verifiers: [
    { name: "Adv. Ndlovu", role: "executor" },
    { name: "Ms. Pillay", role: "attorney" },
    { name: "Uncle Bongani", role: "family" },
  ],
  rules: [
    { beneficiaryLabel: "Lerato (daughter)", category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 4000, lifetimeCapUsdt: 16000, validUntil: "2031-12-31", notes: "University fees paid to the university only", startsNow: false },
    { beneficiaryLabel: "Lerato (daughter)", category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaimUsdt: 600, lifetimeCapUsdt: 9000, validUntil: "2031-12-31", notes: "Residence rent on a monthly schedule, starting now (living plan)", startsNow: true, recurring: { amountUsdt: 300, every: "month", payeeName: "Tugwell Residence" } },
    { beneficiaryLabel: "Sipho (son)", category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 4000, lifetimeCapUsdt: 16000, validUntil: "2033-12-31", notes: "University fees paid to the university only", startsNow: false },
    { beneficiaryLabel: "Naledi (daughter)", category: "Tuition", allowedPayeeKind: "School", maxPerClaimUsdt: 2500, lifetimeCapUsdt: 12000, validUntil: "2034-12-31", notes: "School fees, claimable now with Thabo's approval (living plan)", startsNow: true },
  ],
  // The will names one asset (the schema allows one); Thabo's motorbike is added next to it, as on the demo site
  // (scripts/seed-guardians-assets.ts registers both on devnet).
  assets: [{
    title: "2017 Toyota Corolla 1.8 Exclusive CVT", floorPriceUsdt: 12500, hardshipFloorUsdt: 10500, askingPriceUsdt: 13500,
    proceedsTo: "estate vault", hardshipPolicy: "Below the floor only for proven hardship, approved by 2 of 3 verifiers, never below 10,500 USD₮",
  }],
  waitingPeriodDays: 14,
  plainLanguageSummary:
    "Thabo's USD₮ pays his children's education directly to their university, school or residence, within fixed caps. " +
    "Two rules work now, while he is alive: Lerato's residence rent is scheduled every month, and Naledi's school fees can be claimed with his approval. " +
    "Everything else waits until two of three verifiers confirm his death and 14 days pass, and he can veto at any time. " +
    "The Corolla is sold for at least 12,500 USD₮, or at least 10,500 USD₮ if a child proves real hardship.",
};

const FULL_NAMES: Record<string, string> = { "Adv. Ndlovu": "Adv. Thandi Ndlovu", "Ms. Pillay": "Ms. Anita Pillay", "Uncle Bongani": "Uncle Bongani Mokoena" };
export const CANNED_WILL: WillDraft = { ...DEMO_WILL, verifiers: DEMO_WILL.verifiers.map((v) => ({ ...v, name: FULL_NAMES[v.name] ?? v.name })) };

export function cannedWillTurn(turns: number): { reply: string; draft: WillDraft | null } {
  if (turns <= 1) {
    return { reply: `${CANNED_PREFIX}Thanks, Thabo. Who should benefit, and what should the money be used for? For example: university fees paid straight to the university, up to a yearly amount.`, draft: null };
  }
  return { reply: `${CANNED_PREFIX}Here is a draft based on what you told me. Please check each rule before you sign.`, draft: CANNED_WILL };
}

export function cannedReport(purpose: "death" | "claim" | "hardship" | "seat-death" | "fallback-death"): ModelReport {
  const certificate = { documentType: "death_certificate", extracted: [{ field: "issuer", value: "Department of Home Affairs (demo)" }] };
  const base = {
    death: certificate, "seat-death": certificate, "fallback-death": certificate,
    claim: { documentType: "fee_statement", extracted: [{ field: "institution", value: "University of Cape Town (demo)" }] },
    hardship: { documentType: "affidavit", extracted: [{ field: "commissioner", value: "SAPS (demo)" }] },
  }[purpose];
  return {
    verdict: "needs_human",
    ...base,
    redFlags: ["The AI reviewer is not configured, so this document was NOT read. A human must check it."],
    confidence: 0,
    summary: `${CANNED_PREFIX}No automatic review was done. Verifiers must read the document themselves.`,
  };
}

export function cannedValuation(): CarValuation {
  return {
    suggestedAskingUsdt: 13500, lowUsdt: 12500, highUsdt: 14200,
    comparables: [
      { title: "2017 Toyota Corolla 1.8 Exclusive CVT, 118,000 km (demo)", priceZar: 229_900, source: "demo data" },
      { title: "2017 Toyota Corolla 1.8 Prestige CVT, 131,000 km (demo)", priceZar: 214_995, source: "demo data" },
      { title: "2018 Toyota Corolla 1.8 Exclusive CVT, 105,000 km (demo)", priceZar: 244_900, source: "demo data" },
    ],
    rationale: `${CANNED_PREFIX}Fixed example comparables; live web-search valuation needs GEMINI_API_KEY.`,
  };
}
