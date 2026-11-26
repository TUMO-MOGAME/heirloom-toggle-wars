import type { Recurrence, Rule as ChainRule, WillDraft } from "./types";
import { fullName } from "./names";
import { MIN_DEATH_WAITING_SECS, clampDeathWaiting } from "./continuity/logic";

type Rule = WillDraft["rules"][number];

/** Demo clock (mock): a 30 day waiting period lasts 60 seconds. */
export const DEMO_SECONDS_PER_DAY = 2;

/**
 * The waiting period the plan will really get, in seconds, so the review shows what the estate will use:
 * - the demo (mock) runs days on its demo clock (DEMO_SECONDS_PER_DAY, at least 5 s);
 * - chain uses NEXT_PUBLIC_DEMO_WAITING_SECS when it is set (demo deployments, e.g. 300 s), else the days drafted.
 * An unset or empty variable is "not set" (Number("") is 0, which once made every chain wait 0 s).
 */
export function waitingSecsFor(days: number, mode: "mock" | "chain", demoWaitEnv: string | undefined = process.env.NEXT_PUBLIC_DEMO_WAITING_SECS): number {
  // A new estate's death wait is at least 5 minutes in both services (plan §22.1 P1), the demo clock included.
  if (mode === "mock") return Math.max(MIN_DEATH_WAITING_SECS, Math.round(days * DEMO_SECONDS_PER_DAY));
  const demo = demoWaitEnv === undefined || demoWaitEnv.trim() === "" ? NaN : Number(demoWaitEnv);
  // As the program takes it (M5, P1): never shorter than its 5 minutes, never longer than a year.
  return clampDeathWaiting(Number.isFinite(demo) && demo >= 0 ? demo : Math.round(days * 86_400));
}

/** "30 days", or "300 seconds (demo clock)" when the period is shorter than a day. */
export function waitingText(secs: number, words: { periodDays: string; periodDemo: string }): string {
  return secs >= 86_400 ? fill(words.periodDays, { days: Math.round(secs / 86_400) }) : fill(words.periodDemo, { secs });
}

/**
 * The interval word for a signed rule on /will: the interval the owner signed when it is known (the demo's 60 s clock
 * would otherwise read "every minute" for a monthly payment), else the nearest word for the interval in seconds.
 */
export function signedEvery(rule: Pick<ChainRule, "every" | "intervalSecs">): Recurrence {
  if (rule.every) return rule.every;
  const secs = rule.intervalSecs;
  if (secs <= 60) return "minute";
  if (secs <= 8 * 86400) return "week";
  if (secs <= 32 * 86400) return "month";
  if (secs <= 200 * 86400) return "term";
  return "year";
}

/** Same key as the will screen's Now / After toggles: who + what, so a re-ordered draft keeps each choice on its rule. */
export const ruleKey = (r: Rule) => `${r.beneficiaryLabel}|${r.category}|${r.recurring ? "recurring" : "claim"}`;

/** The review copy the summary is written from (content/screens.ts `will.review`). */
export interface SummaryWords {
  summaryNow: string;
  summaryNoneNow: string;
  summaryLater: string;
  summaryNoneLater: string;
  summaryItem: string;
  summaryItemRecurring: string;
  summaryAsset: string;
}


export interface SummaryFormat {
  category: (c: Rule["category"]) => string;
  every: (e: NonNullable<Rule["recurring"]>["every"]) => string;
  usd: (n: number) => string;
  /** How many trusted people must confirm the passing. */
  need: number;
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/**
 * True when the plan the owner will sign no longer matches the agent's summary: a rule was switched between Now and
 * After I'm gone, or a rule was added that the agent never saw (a ready-made bill).
 */
export function timingChanged(agentRules: readonly Rule[], rules: readonly Rule[]): boolean {
  const agent = new Map(agentRules.map((r) => [ruleKey(r), r.startsNow] as const));
  return rules.some((r) => {
    const k = ruleKey(r);
    return !agent.has(k) || agent.get(k) !== r.startsNow;
  });
}

/** A plain summary written from the rules themselves: what starts now, what waits until after the passing, the car. */
export function planSummary(draft: WillDraft, words: SummaryWords, f: SummaryFormat): string {
  const item = (r: Rule) => {
    // "Lerato (daughter)" → "Lerato", so the item doesn't carry two brackets.
    const v = { name: fullName(r.beneficiaryLabel) || r.beneficiaryLabel, category: f.category(r.category).toLowerCase() };
    return r.recurring
      ? fill(words.summaryItemRecurring, { ...v, amount: f.usd(r.recurring.amountUsdt), every: f.every(r.recurring.every) })
      : fill(words.summaryItem, v);
  };
  const now = draft.rules.filter((r) => r.startsNow).map(item);
  const later = draft.rules.filter((r) => !r.startsNow).map(item);
  const parts = [
    now.length ? fill(words.summaryNow, { list: now.join("; ") }) : words.summaryNoneNow,
    later.length ? fill(words.summaryLater, { list: later.join("; "), need: f.need, days: draft.waitingPeriodDays }) : words.summaryNoneLater,
  ];
  const asset = draft.assets[0];
  if (asset) parts.push(fill(words.summaryAsset, { title: asset.title, floor: f.usd(asset.floorPriceUsdt), hardship: f.usd(asset.hardshipFloorUsdt) }));
  return parts.join(" ");
}

/**
 * The draft as it will be signed: the owner's choices win, and when they change the timing the agent's summary (which
 * describes the agent's timing) is replaced by one written from the rules, so the summary and the hashed will agree.
 */
export function withOwnerSummary(agentDraft: WillDraft, rules: Rule[], words: SummaryWords, f: SummaryFormat): { draft: WillDraft; edited: boolean } {
  const draft = { ...agentDraft, rules };
  if (!timingChanged(agentDraft.rules, rules)) return { draft, edited: false };
  return { draft: { ...draft, plainLanguageSummary: planSummary(draft, words, f) }, edited: true };
}
