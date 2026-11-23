/**
 * The monthly statement (plan.md §13.4): what the plan paid in one calendar month, to whom, for what and for
 * whom, with each payment's receipt, totals per purpose and per person, and what is scheduled for the month after.
 *
 * Built from the same activity feed as the Proof drawer (snap.activity), in both modes: chain events carry the
 * payee, rule and claim (ActivityItem.payment), the demo logs the same. Months are South African calendar months
 * (Africa/Johannesburg, UTC+2 all year: no daylight saving since 1944), whatever the viewer's own time zone.
 */
import type { EstateSnapshot } from "../service/types";
import type { ActivityItem, Base58, Category, Rule } from "../types";
import { isCurrentClaim } from "../death-rules";

export const STATEMENT_TZ = "Africa/Johannesburg";
const SAST_OFFSET_SECS = 2 * 3600;
/** Activity kinds that move USD₮ out of the vault to a payee. */
export const PAYMENT_KINDS = ["ClaimPaid", "ScheduledPaid", "FallbackExecuted"] as const;
/** At or below this, a schedule runs on the demo clock (every minute stands for its real interval). */
export const DEMO_CLOCK_SECS = 60;

/** "2026-11". */
export type MonthKey = string;

const keyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: STATEMENT_TZ, year: "numeric", month: "2-digit" });

/** The South African calendar month a unix time (seconds) falls in. */
export function monthKey(ts: number): MonthKey {
  const parts = keyFormat.formatToParts(new Date(ts * 1000));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

export function isMonthKey(v: unknown): v is MonthKey {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** [start, end) in unix seconds: midnight on the 1st in Johannesburg to midnight on the 1st of the next month. */
export function monthRange(key: MonthKey): { start: number; end: number } {
  const [y, m] = key.split("-").map(Number);
  return { start: Date.UTC(y, m - 1, 1) / 1000 - SAST_OFFSET_SECS, end: Date.UTC(y, m, 1) / 1000 - SAST_OFFSET_SECS };
}

/** The month after (delta 1) or before (delta -1). */
export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Every month from the estate's first activity (or `now`'s month) to `now`'s month, newest first. */
export function statementMonths(activity: readonly ActivityItem[], now: number): MonthKey[] {
  const last = monthKey(now);
  const firstTs = activity.reduce((min, a) => Math.min(min, a.ts), now);
  let k = monthKey(firstTs);
  const out: MonthKey[] = [];
  for (let guard = 0; k <= last && guard < 240; guard++, k = shiftMonth(k, 1)) out.unshift(k);
  return out;
}

/** What a payment was for: the rule's category, the fallback plan, or not known (a rule the app can't find). */
export type Purpose = Category | "Fallback" | "Unknown";

export interface StatementLine {
  ts: number;
  amount: bigint;
  /** The wallet paid (an institution, or a fallback recipient). */
  payee: Base58 | null;
  /** Who the payment was for (the rule's family member; for the fallback plan, the recipient). */
  person: Base58 | null;
  purpose: Purpose;
  kind: (typeof PAYMENT_KINDS)[number];
  /** A scheduled payment (no claim) or a claim paid against an invoice. */
  scheduled: boolean;
  rule: Base58 | null;
  txSignature?: string;
  /** The activity line itself, for its text when the app knows no names. */
  item: ActivityItem;
}

export interface Total<K> { key: K; amount: bigint; count: number }

export interface UpcomingLine {
  rule: Base58;
  payee: Base58 | null;
  person: Base58;
  purpose: Category;
  amount: bigint;
  /** How many times it falls due in the month (capped by what is left under the rule). */
  count: number;
  total: bigint;
  /** First due time in the month (unix seconds), or null on the demo clock. */
  firstDue: number | null;
}

export interface Statement {
  month: MonthKey;
  start: number;
  end: number;
  lines: StatementLine[];
  total: bigint;
  byPurpose: Total<Purpose>[];
  byPerson: Total<Base58 | null>[];
  /**
   * False when the loaded activity may not reach back to the start of the month (the chain feed holds the most
   * recent events only), so older payments in this month could be missing.
   */
  complete: boolean;
}

const isPayment = (a: ActivityItem): a is ActivityItem & { kind: (typeof PAYMENT_KINDS)[number]; amount: bigint } =>
  (PAYMENT_KINDS as readonly string[]).includes(a.kind) && typeof a.amount === "bigint";

/** The rule (and claim) behind a payment line: from the event, else the claim paid in the same transaction. */
function ruleOf(snap: EstateSnapshot, a: ActivityItem): { rule: Rule | null; person: Base58 | null } {
  const ref = a.payment;
  const claim = (ref?.claim && snap.claims.find((c) => c.address === ref.claim))
    || (a.txSignature ? snap.claims.find((c) => c.txSignature === a.txSignature) : undefined);
  const ruleAddr = ref?.rule ?? claim?.rule;
  let rule = ruleAddr ? snap.rules.find((r) => r.address === ruleAddr) ?? null : null;
  // A reused slot keeps its address: a payment under the rule that held it before is not the new rule's. A claim
  // says which by its id; a scheduled payment by coming before the slot's RuleReused line (the feed is newest first).
  if (rule && claim && rule.claimCount !== undefined && !isCurrentClaim(claim.id, rule.claimCount)) return { rule: null, person: claim.beneficiary };
  if (rule && !claim) {
    const at = snap.activity.indexOf(a);
    const reused = snap.activity.findIndex((x) => x.kind === "RuleReused" && x.reusedRule === rule!.address);
    if (reused >= 0 && at > reused) return { rule: null, person: null };
  }
  // An older demo line without a reference: a schedule paying exactly this amount, when only one does.
  if (!rule && a.kind === "ScheduledPaid") {
    const same = snap.rules.filter((r) => r.recurringAmount > BigInt(0) && r.recurringAmount === a.amount
      && (!ref?.payee || r.fixedPayee === ref.payee));
    if (same.length === 1) rule = same[0];
  }
  return { rule, person: rule?.beneficiary ?? claim?.beneficiary ?? null };
}

function totals<K>(lines: StatementLine[], keyOf: (l: StatementLine) => K): Total<K>[] {
  const map = new Map<K, Total<K>>();
  for (const l of lines) {
    const k = keyOf(l);
    const t = map.get(k) ?? { key: k, amount: BigInt(0), count: 0 };
    t.amount += l.amount;
    t.count += 1;
    map.set(k, t);
  }
  return [...map.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

/** The statement for `month`: every vault payment in it, oldest first, with totals. */
export function buildStatement(snap: EstateSnapshot, month: MonthKey): Statement {
  const { start, end } = monthRange(month);
  const lines: StatementLine[] = snap.activity
    .filter(isPayment)
    .filter((a) => a.ts >= start && a.ts < end)
    .map((a) => {
      const fallback = a.kind === "FallbackExecuted";
      const { rule, person } = fallback ? { rule: null, person: a.payment?.payee ?? null } : ruleOf(snap, a);
      const scheduled = a.kind === "ScheduledPaid";
      return {
        ts: a.ts, amount: a.amount, kind: a.kind, scheduled,
        payee: a.payment?.payee ?? (scheduled ? rule?.fixedPayee ?? null : null) ?? a.parties?.[0] ?? null,
        person,
        purpose: fallback ? "Fallback" : rule?.category ?? "Unknown",
        rule: rule?.address ?? null,
        txSignature: a.txSignature,
        item: a,
      } satisfies StatementLine;
    })
    .sort((a, b) => a.ts - b.ts);
  const total = lines.reduce((s, l) => s + l.amount, BigInt(0));
  const oldest = snap.activity.reduce((min, a) => Math.min(min, a.ts), Infinity);
  const fromStart = snap.activity.some((a) => a.kind === "EstateCreated");
  return {
    month, start, end, lines, total,
    byPurpose: totals(lines, (l) => l.purpose),
    byPerson: totals(lines, (l) => l.person),
    complete: fromStart || oldest < start,
  };
}

/**
 * What the plan's schedules will pay in `month`: each schedule that runs then (living rules while the estate is
 * Active, every schedule once it is Unlocked), counted from its next due date, never past its end date or what is
 * left under its total. On the demo clock (a schedule every minute) each counts once, as the month it stands for.
 */
export function upcoming(snap: EstateSnapshot, month: MonthKey): UpcomingLine[] {
  const { start, end } = monthRange(month);
  const status = snap.estate.status;
  const out: UpcomingLine[] = [];
  for (const r of snap.rules) {
    if (r.recurringAmount <= BigInt(0) || !r.fixedPayee) continue;
    const runs = status === "Unlocked" || (status === "Active" && r.startsNow);
    if (!runs) continue;
    const left = r.lifetimeCap - r.spentTotal;
    const affordable = Number(left / r.recurringAmount);
    if (affordable <= 0 || r.validUntil < start) continue;
    let count: number;
    let firstDue: number | null = null;
    if (r.intervalSecs <= DEMO_CLOCK_SECS) {
      count = 1;
    } else {
      // Unlocked legacy schedules with no due date yet start at once.
      let due = r.nextDue ?? start;
      if (due < start) due += Math.ceil((start - due) / r.intervalSecs) * r.intervalSecs;
      const stop = Math.min(end, r.validUntil + 1);
      count = due < stop ? Math.floor((stop - 1 - due) / r.intervalSecs) + 1 : 0;
      firstDue = count > 0 ? due : null;
    }
    count = Math.min(count, affordable);
    if (count <= 0) continue;
    out.push({ rule: r.address, payee: r.fixedPayee, person: r.beneficiary, purpose: r.category, amount: r.recurringAmount, count, total: r.recurringAmount * BigInt(count), firstDue });
  }
  return out.sort((a, b) => (a.firstDue ?? 0) - (b.firstDue ?? 0));
}
