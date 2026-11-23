/**
 * Invoice reading (the AI) and the check against what the owner typed (this file). Client-safe.
 * The AI only reads and recommends: a mismatch is shown plainly on the bill form and in the review sheet,
 * and the owner decides. Nothing here blocks a payment.
 */
import { z } from "zod";

/** What the AI returns for one invoice photo or PDF. Validated before use (server and client). */
export const invoiceReadingSchema = z.object({
  /** False when the file is not an invoice, quote or bill (a till slip, a selfie, a blank page). */
  isInvoice: z.boolean(),
  payeeName: z.string().trim().max(120).nullable(),
  /** The total due, in `currency`. */
  amount: z.number().positive().max(100_000_000).nullable(),
  currency: z.enum(["ZAR", "USD", "USDT", "other"]).nullable(),
  /** Invoice number or payment reference. */
  reference: z.string().trim().max(60).nullable(),
  description: z.string().trim().max(200).nullable(),
  redFlags: z.array(z.string().max(300)).max(10),
  confidence: z.number().min(0).max(1),
});
export type InvoiceReading = z.infer<typeof invoiceReadingSchema>;

/** The answer of the invoice route and of the demo service. `engine: "demo"` = scripted (demo site), "none" = no AI configured; both labelled on screen. */
export const invoiceReadSchema = z.object({
  reading: invoiceReadingSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  engine: z.enum(["ai", "demo", "none"]),
});
export type InvoiceRead = z.infer<typeof invoiceReadSchema>;

/** What the owner typed on the bill form. */
export interface TypedBill {
  payee: string;
  amountUsdt: number;
  /** Set when the owner typed rand. */
  amountZar: number | null;
  reference: string | null;
}

export type InvoiceField = "document" | "payee" | "amount" | "reference";
export interface InvoiceIssue {
  field: InvoiceField;
  /** "mismatch" = the invoice says something else; "info" = worth knowing, not a disagreement. */
  level: "mismatch" | "info";
  /** For "info": why ("missing", "currency", "rate", "addReference", "lowConfidence"). */
  reason?: "notInvoice" | "lowConfidence" | "currency" | "rate" | "addReference";
  invoice?: string;
  typed?: string;
}
export interface InvoiceComparison { status: "match" | "mismatch" | "unread"; issues: InvoiceIssue[] }

/** Confidence below this means "we could not read it well enough to compare". */
export const MIN_CONFIDENCE = 0.5;
/** Rand amounts may differ by up to R1 (rounding); converted amounts by 1% (the rate moves). */
const ZAR_TOLERANCE = 1;
const RATE_TOLERANCE = 0.01;

const GENERIC = new Set(["inc", "pty", "ltd", "cc", "co", "the", "and", "of", "npc", "llp", "sa", "za"]);
export const nameTokens = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 1 && !GENERIC.has(t));

/** Same business: every meaningful word of one name appears in the other ("Ndlovu Attorneys" ~ "Ndlovu Attorneys Inc."). */
export function sameName(a: string, b: string): boolean {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return false;
  const inY = x.every((t) => y.includes(t)), inX = y.every((t) => x.includes(t));
  return inY || inX;
}

export const normRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

const rand = (n: number) => `R${n.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}`;
const usdt = (n: number) => `${n.toLocaleString("en-ZA", { maximumFractionDigits: 2 })} USD₮`;

/** Compares the invoice with what was typed. `usdtZar` is the live rate (rand per USD₮), or null when unknown. */
export function compareInvoice(r: InvoiceReading, typed: TypedBill, usdtZar: number | null): InvoiceComparison {
  if (!r.isInvoice) return { status: "unread", issues: [{ field: "document", level: "info", reason: "notInvoice" }] };
  if (r.confidence < MIN_CONFIDENCE) return { status: "unread", issues: [{ field: "document", level: "info", reason: "lowConfidence" }] };
  const issues: InvoiceIssue[] = [];

  if (r.payeeName && typed.payee.trim() && !sameName(r.payeeName, typed.payee)) {
    issues.push({ field: "payee", level: "mismatch", invoice: r.payeeName, typed: typed.payee.trim() });
  }

  if (r.amount !== null) {
    const rate = usdtZar && usdtZar > 0 ? usdtZar : null;
    if (r.currency === "ZAR" || r.currency === null) {
      const typedZar = typed.amountZar ?? (rate ? typed.amountUsdt * rate : null);
      if (typedZar === null) issues.push({ field: "amount", level: "info", reason: "rate", invoice: rand(r.amount) });
      else {
        const tol = typed.amountZar !== null ? ZAR_TOLERANCE : Math.max(ZAR_TOLERANCE, r.amount * RATE_TOLERANCE);
        if (Math.abs(typedZar - r.amount) > tol) issues.push({ field: "amount", level: "mismatch", invoice: rand(r.amount), typed: typed.amountZar !== null ? rand(typed.amountZar) : usdt(typed.amountUsdt) });
      }
    } else if (r.currency === "USD" || r.currency === "USDT") {
      if (Math.abs(typed.amountUsdt - r.amount) > Math.max(0.01, r.amount * (typed.amountZar !== null ? RATE_TOLERANCE : 0))) {
        issues.push({ field: "amount", level: "mismatch", invoice: usdt(r.amount), typed: typed.amountZar !== null ? rand(typed.amountZar) : usdt(typed.amountUsdt) });
      }
    } else issues.push({ field: "amount", level: "info", reason: "currency" });
  }

  if (r.reference) {
    if (typed.reference?.trim()) {
      if (normRef(r.reference) !== normRef(typed.reference)) issues.push({ field: "reference", level: "mismatch", invoice: r.reference, typed: typed.reference.trim() });
    } else issues.push({ field: "reference", level: "info", reason: "addReference", invoice: r.reference });
  }

  return { status: issues.some((i) => i.level === "mismatch") ? "mismatch" : "match", issues };
}

/** Rand → USD₮ at the live rate, to the cent. */
export const zarToUsdt = (zar: number, usdtZar: number) => Math.round((zar / usdtZar) * 100) / 100;
