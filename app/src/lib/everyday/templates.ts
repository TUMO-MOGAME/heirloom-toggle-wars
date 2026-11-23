/**
 * Bill templates (plan.md §13.3): ready-made rules for the bills families pay every month, pre-filled and fully
 * editable before signing. They use the existing rule model only (category, payee kind, per-payment and total caps,
 * end date, starts now or after I'm gone, an optional schedule), so nothing here needs a program change.
 *
 * Two places use them: the plan builder while the will is still a draft (a template becomes a WillDraft rule) and
 * the signed plan while the estate is Active (a template becomes an `addRule` call). The contract enforces the
 * caps either way; `checkBill` only catches the same mistakes early, in plain words.
 */
import type { Category, PayeeKind, WillDraft } from "../types";
import { scheduleSecs } from "../schedule-clock";

export const TEMPLATE_KEYS = ["funeral", "parent", "medical", "school", "books", "legal"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type Every = "month" | "term" | "year";

export interface BillTemplate {
  key: TemplateKey;
  category: Category;
  payeeKind: PayeeKind;
  /** Paid every `every` to one payee (a schedule), or claimed against an invoice (no schedule). */
  scheduled: boolean;
  /** Each payment (schedule) or the most per claim (claims), in USD₮. */
  amountUsdt: number;
  every: Every;
  /** How long the rule runs, in years from today. */
  years: number;
  /** true: works now, while the owner is alive. false: only after the estate unlocks. */
  startsNow: boolean;
  /** The payee is usually not one the plan knows yet (an insurer, a medical scheme): the signed form starts on "a new payee". */
  newPayee?: boolean;
}

/**
 * Defaults at about R17.50 to the USD₮: funeral cover ≈ R440 a month, a parent's rent ≈ R3,500 a month, medical aid
 * ≈ R2,600 a month, school fees ≈ R8,750 a term, books ≈ R1,500 a month. Legal and executor fees are claimed against
 * the lawyer's invoice after a passing; their total is capped by `executorCapUsdt`.
 */
export const BILL_TEMPLATES: Record<TemplateKey, BillTemplate> = {
  funeral: { key: "funeral", category: "General", payeeKind: "Other", scheduled: true, amountUsdt: 25, every: "month", years: 10, startsNow: true, newPayee: true },
  parent: { key: "parent", category: "Accommodation", payeeKind: "Landlord", scheduled: true, amountUsdt: 200, every: "month", years: 3, startsNow: true },
  medical: { key: "medical", category: "Medical", payeeKind: "Other", scheduled: true, amountUsdt: 150, every: "month", years: 3, startsNow: true, newPayee: true },
  school: { key: "school", category: "Tuition", payeeKind: "School", scheduled: true, amountUsdt: 500, every: "term", years: 4, startsNow: true },
  books: { key: "books", category: "Books", payeeKind: "Other", scheduled: true, amountUsdt: 85, every: "month", years: 3, startsNow: true },
  legal: { key: "legal", category: "General", payeeKind: "Other", scheduled: false, amountUsdt: 1500, every: "month", years: 5, startsNow: false },
};

/** Payments a year for each interval (a school year has four terms). */
export const PER_YEAR: Record<Every, number> = { month: 12, term: 4, year: 1 };

/** South Africa: executor fees are capped at 3.5% of the gross estate, plus VAT (15%). */
export const EXECUTOR_RATE = 0.035;
export const VAT_RATE = 0.15;
/** Used when the estate's value is not known yet (a draft with nothing in the vault). */
export const EXECUTOR_DEFAULT_USDT = 1500;

const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

/** 3.5% of the estate plus VAT, rounded up to 50 USD₮; the default when the estate's value is unknown or zero. */
export function executorCapUsdt(estateUsdt: number | null | undefined): number {
  if (!estateUsdt || !Number.isFinite(estateUsdt) || estateUsdt <= 0) return EXECUTOR_DEFAULT_USDT;
  return Math.max(50, roundUp(estateUsdt * EXECUTOR_RATE * (1 + VAT_RATE), 50));
}

/** The editable form a template opens as. Amounts are whole USD₮; `until` is YYYY-MM-DD. */
export interface BillForm {
  key: TemplateKey;
  category: Category;
  payeeKind: PayeeKind;
  scheduled: boolean;
  /** Who the rule is for (a draft beneficiary's label, or a beneficiary wallet once signed). */
  beneficiary: string;
  /** Scheduled bills: the payee's name (draft) or wallet (signed). Claims leave it empty. */
  payee: string;
  amountUsdt: number;
  every: Every;
  /** Most paid in total under this rule. */
  capUsdt: number;
  until: string;
  startsNow: boolean;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The template's defaults as a form, `now` in ms. Scheduled: total = each payment × payments over the years. */
export function templateForm(key: TemplateKey, opts: { now: number; beneficiary?: string; payee?: string; estateUsdt?: number | null }): BillForm {
  const t = BILL_TEMPLATES[key];
  const until = new Date(opts.now);
  until.setUTCFullYear(until.getUTCFullYear() + t.years);
  const amount = key === "legal" ? executorCapUsdt(opts.estateUsdt) : t.amountUsdt;
  return {
    key, category: t.category, payeeKind: t.payeeKind, scheduled: t.scheduled,
    beneficiary: opts.beneficiary ?? "", payee: t.scheduled ? opts.payee ?? "" : "",
    amountUsdt: amount, every: t.every,
    capUsdt: t.scheduled ? amount * PER_YEAR[t.every] * t.years : amount,
    until: isoDay(until), startsNow: t.startsNow,
  };
}

export type BillError = "beneficiary" | "payee" | "amount" | "cap" | "until";
const MAX_USDT = 1_000_000;

/** The form's mistakes, one per field, in the order the form shows them. Empty = ready to add. `now` in ms. */
export function checkBill(f: BillForm, now: number): Partial<Record<BillError, true>> {
  const out: Partial<Record<BillError, true>> = {};
  const ok = (n: number) => Number.isFinite(n) && n > 0 && n <= MAX_USDT;
  if (!f.beneficiary.trim()) out.beneficiary = true;
  if (f.scheduled && !f.payee.trim()) out.payee = true;
  if (!ok(f.amountUsdt)) out.amount = true;
  // The contract: per payment (or per claim) > 0 and never above the total.
  if (!ok(f.capUsdt) || (ok(f.amountUsdt) && f.capUsdt < f.amountUsdt)) out.cap = true;
  const end = Date.parse(f.until);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.until) || !Number.isFinite(end) || end <= now) out.until = true;
  return out;
}

/** The form as a will-draft rule (the plan builder, before signing). `notes` is the template's plain name. */
export function toDraftRule(f: BillForm, notes: string): WillDraft["rules"][number] {
  return {
    beneficiaryLabel: f.beneficiary,
    category: f.category,
    allowedPayeeKind: f.payeeKind,
    maxPerClaimUsdt: f.amountUsdt,
    lifetimeCapUsdt: f.capUsdt,
    validUntil: f.until,
    notes: notes.slice(0, 300),
    startsNow: f.startsNow,
    ...(f.scheduled ? { recurring: { amountUsdt: f.amountUsdt, every: f.every, payeeName: f.payee.trim().slice(0, 64) } } : {}),
  };
}

/** Seconds between payments. The demo clock (mock mode) repeats every schedule every minute, as the demo does. */
export function intervalOf(every: Every, demo: boolean): number {
  return scheduleSecs(every, demo ? "mock" : "chain");
}

/** The form as `addRule` input (a signed plan, estate Active). `now` in ms; the first payment is one interval away. */
export function toAddRule(f: BillForm, opts: { now: number; demo: boolean }) {
  const secs = Math.floor(opts.now / 1000);
  const every = intervalOf(f.every, opts.demo);
  return {
    beneficiary: f.beneficiary,
    category: f.category,
    allowedPayeeKind: f.payeeKind,
    maxPerClaimUsdt: f.amountUsdt,
    lifetimeCapUsdt: f.capUsdt,
    // End of that day in South Africa (UTC+2).
    validUntil: Math.floor(Date.parse(`${f.until}T23:59:59+02:00`) / 1000),
    startsNow: f.startsNow,
    ...(f.scheduled ? { recurring: { amountUsdt: f.amountUsdt, intervalSecs: every, firstDue: secs + every, payee: f.payee, every: f.every } } : {}),
  };
}
