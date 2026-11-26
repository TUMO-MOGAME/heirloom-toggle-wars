/**
 * Continuity rules shared by both services and the screens; mirrors programs/heirloom (continuity.rs and
 * execute_scheduled). Pure.
 */
import type { Base58, Beneficiary, Payee, Rule } from "../types";
import type { RemoveMemberInput } from "./types";

export const MAX_RULES = 16;
export const MIN_WAITING_SECS = 60;
export const MAX_WAITING_SECS = 365 * 86_400;
export const MIN_LISTING_SECS = 3_600;

/** A new estate's death quorum and death wait (plan §22.1 P1): at least two trusted people and five minutes. */
export const MIN_DEATH_THRESHOLD = 2;
export const MIN_DEATH_WAITING_SECS = 300;

export function clampWaiting(secs: number): number {
  return Math.min(MAX_WAITING_SECS, Math.max(MIN_WAITING_SECS, Math.round(secs)));
}

/** The wait a new estate is signed with: never under the 5 minutes the program asks of a new death wait (P1). */
export function clampDeathWaiting(secs: number): number {
  return Math.max(MIN_DEATH_WAITING_SECS, clampWaiting(secs));
}

/**
 * Live rules whose beneficiary the owner removed. After the unlock anyone may end them (end_orphan_rule, P3): nothing
 * under them can pay, so their reserve goes to the sweep. Only a beneficiary on record and inactive counts.
 */
export function orphanRules<R extends Pick<Rule, "beneficiary" | "validUntil">>(rules: R[], beneficiaries: Pick<Beneficiary, "wallet" | "active">[], now: number): R[] {
  const removed = new Set(beneficiaries.filter((b) => !b.active).map((b) => b.wallet));
  const active = new Set(beneficiaries.filter((b) => b.active).map((b) => b.wallet));
  return rules.filter((r) => now <= r.validUntil && removed.has(r.beneficiary) && !active.has(r.beneficiary));
}

/** What live rules can still claim: the part of the vault a sweep must leave. */
export function reservedByRules(rules: Pick<Rule, "validUntil" | "lifetimeCap" | "spentTotal">[], now: number): bigint {
  let reserved = 0n;
  for (const r of rules) {
    if (now <= r.validUntil && r.lifetimeCap > r.spentTotal) reserved += r.lifetimeCap - r.spentTotal;
  }
  return reserved;
}

/** What sweep_residual would pay now. */
export function surplusOf(vault: bigint, rules: Pick<Rule, "validUntil" | "lifetimeCap" | "spentTotal">[], now: number): bigint {
  const reserved = reservedByRules(rules, now);
  return vault > reserved ? vault - reserved : 0n;
}

/** What a sweep pays after the unlock: the removed beneficiaries' rules are ended first, so they reserve nothing (P3). */
export function sweepableSurplus(vault: bigint, rules: Pick<Rule, "beneficiary" | "validUntil" | "lifetimeCap" | "spentTotal">[], beneficiaries: Pick<Beneficiary, "wallet" | "active">[], now: number): bigint {
  const orphans = new Set(orphanRules(rules, beneficiaries, now));
  return surplusOf(vault, rules.filter((r) => !orphans.has(r)), now);
}

/** The date after a payment at `now`: the first one on the schedule after now, so missed dates never pay together. */
export function nextDueAfter(due: number, intervalSecs: number, now: number): number {
  if (intervalSecs <= 0) return due;
  return due + (Math.floor((now - due) / intervalSecs) + 1) * intervalSecs;
}

/** Who a sweep pays: the named person, else the first living fallback recipient. */
export function residualRecipient(named: Base58 | null, fallback: { wallets: Base58[]; deadMask: number } | null, nobody: Base58): Base58 | null {
  if (named) return named;
  return fallback?.wallets.find((w, i) => w !== nobody && (fallback.deadMask & (1 << i)) === 0) ?? null;
}

export const listingEnded = (a: { status: string; listingEnds: number | null }, now: number): boolean =>
  a.status === "Listed" && a.listingEnds !== null && now >= a.listingEnds;

/** An ended rule gives up its slot; a live one's cap still matters (R17). */
export const ruleEnded = (r: Pick<Rule, "validUntil">, now: number) => now > r.validUntil;

/**
 * The slot a new rule takes: none while the plan has room. At the limit, the rule that ended first, so history about
 * the most recent rules keeps reading right.
 */
export function slotToReuse(rules: readonly Rule[], now: number): Rule | null {
  if (rules.length < MAX_RULES) return null;
  return rules.filter((r) => ruleEnded(r, now)).sort((a, b) => a.validUntil - b.validUntil || a.id - b.id)[0] ?? null;
}

/** Live rules only the removed people could use: their own, schedules to the payee, and the last payee of a kind's. */
export function rulesEndedByRemoval(
  snap: { rules: readonly Rule[]; payees: readonly Payee[] }, input: Pick<RemoveMemberInput, "beneficiary" | "payee">, now: number,
): Rule[] {
  const gone = input.payee ? snap.payees.find((p) => p.wallet === input.payee) : undefined;
  const lastOfKind = !!gone && !snap.payees.some((p) => p.wallet !== gone.wallet && p.kind === gone.kind);
  return snap.rules.filter((r) => {
    if (ruleEnded(r, now)) return false;
    if (input.beneficiary && r.beneficiary === input.beneficiary) return true;
    if (!gone) return false;
    return r.recurringAmount > 0n ? r.fixedPayee === gone.wallet : lastOfKind && r.allowedPayeeKind === gone.kind;
  });
}
