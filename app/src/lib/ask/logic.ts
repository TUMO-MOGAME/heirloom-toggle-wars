/**
 * Pure rules for "Ask for money": which payees a family member can ask to be paid to, the same cap checks the program
 * makes at submit_claim (so the form can say no before anything is signed), who decides, and the request's status.
 * The program still makes every check itself; these only explain them early.
 */
import type { EstateSnapshot } from "../service/types";
import type { Base58, Claim, Estate, Payee, Rule } from "../types";
import { yearlyLeft } from "../disputes/types";
import { toBase } from "../format";
import { parseAmount as parseStrict } from "../amount";
import type { AskCurrency, AskNote } from "./types";
import { openToPeople } from "@/lib/verdict";
import { quorum as quorumOf } from "../death-rules";
import { claimBlock, isFamily } from "../guardians/decisions";

/** A rule is open for payments now: always after unlock, and while the owner is alive only if it "starts now". */
export function ruleOpen(estate: Pick<Estate, "status">, rule: Pick<Rule, "startsNow">): boolean {
  return estate.status === "Unlocked" || (estate.status === "Active" && rule.startsNow);
}

export interface AskOption {
  rule: Rule;
  payee: Payee;
  /** The payee is the asker's own wallet (an approved "Other" payee). */
  own: boolean;
  /** Left under the rule's lifetime cap. */
  left: bigint;
  /** Left this year under the rule's yearly cap, or null when it has none. */
  yearLeft: bigint | null;
}

/**
 * Where a family member may ask money to go: every approved payee of the right kind under each of their rules that
 * pays claims (not schedules) and is open now. Everyday ("General") rules first, then the asker's own wallet.
 */
export function askOptions(snap: EstateSnapshot, wallet: Base58 | null | undefined, now: number): AskOption[] {
  // Someone taken out of the plan can't ask (R16).
  if (!wallet || !isFamily(snap, wallet)) return [];
  const out: AskOption[] = [];
  for (const rule of snap.rules) {
    if (rule.beneficiary !== wallet || rule.recurringAmount > BigInt(0) || !ruleOpen(snap.estate, rule) || now > rule.validUntil) continue;
    const left = rule.lifetimeCap > rule.spentTotal ? rule.lifetimeCap - rule.spentTotal : BigInt(0);
    for (const payee of snap.payees) {
      if (payee.kind !== rule.allowedPayeeKind) continue;
      out.push({ rule, payee, own: payee.wallet === wallet, left, yearLeft: yearlyLeft(rule.yearlyCap, now) });
    }
  }
  const rank = (o: AskOption) => (o.rule.category === "General" ? 0 : 2) + (o.own ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.rule.id - b.rule.id || a.payee.name.localeCompare(b.payee.name));
}

export const optionKey = (o: Pick<AskOption, "rule" | "payee">) => `${o.rule.address}:${o.payee.wallet}`;

/** Does this family member have anything they can ask for right now? */
export const canAsk = (snap: EstateSnapshot | null, wallet: Base58 | null | undefined, now: number) =>
  !!snap && askOptions(snap, wallet, now).length > 0;

export type AskProblem =
  | { code: "InvalidAmount" }
  | { code: "ExceedsPerClaimCap"; limit: bigint }
  | { code: "ExceedsLifetimeCap"; limit: bigint }
  | { code: "ExceedsYearlyCap"; limit: bigint };

/** The checks submit_claim makes, in the same order. Null = the program should accept it. */
export function checkAsk(option: AskOption, amount: bigint): AskProblem | null {
  if (amount <= BigInt(0)) return { code: "InvalidAmount" };
  if (amount > option.rule.maxPerClaim) return { code: "ExceedsPerClaimCap", limit: option.rule.maxPerClaim };
  if (amount > option.left) return { code: "ExceedsLifetimeCap", limit: option.left };
  if (option.yearLeft !== null && amount > option.yearLeft) return { code: "ExceedsYearlyCap", limit: option.yearLeft };
  return null;
}

/** The most this option allows in one request right now. */
export function maxAsk(option: AskOption): bigint {
  let m = option.rule.maxPerClaim < option.left ? option.rule.maxPerClaim : option.left;
  if (option.yearLeft !== null && option.yearLeft < m) m = option.yearLeft;
  return m;
}

/**
 * The USD₮ amount for what was typed. Rand converts at the current rate and rounds to the cent; without a rate a rand
 * amount cannot be converted (null). Garbage or zero gives 0.
 */
export function amountUsdt(typed: number, currency: AskCurrency, usdtZar: number | null | undefined): number | null {
  if (!Number.isFinite(typed) || typed <= 0) return 0;
  if (currency === "USDT") return Math.round(typed * 100) / 100;
  if (!usdtZar || usdtZar <= 0) return null;
  return Math.round((typed / usdtZar) * 100) / 100;
}

/** "1 234,50" / "1,234.50" / "9,50" / "R 300" → a number; NaN when it is not one clear amount (lib/amount.ts). */
export function parseAmount(text: string): number {
  return parseStrict(text.trim().replace(/^R\s*/i, "")) ?? NaN;
}

/** Base units for a USD₮ amount (a thin alias, so callers need not import format.ts). */
export const askBase = (usdt: number) => toBase(usdt);

export type Decider = "owner" | "trusted" | "paused" | "later";

/** Who decides a request under `rule` now: the owner while alive (living rule), the trusted people after unlock. */
export function decider(estate: Pick<Estate, "status">, rule: Pick<Rule, "startsNow"> | undefined): Decider {
  if (estate.status === "Unlocked") return "trusted";
  if (estate.status === "Active") return rule?.startsNow ? "owner" : "later";
  return "paused";
}

export type AskStatus = "checking" | "refused" | "waiting" | "declined" | "approved" | "paid";

/**
 * A request's status for the person who asked and for the people who decide.
 * checking: the agent has not checked the document yet; refused: the agent did not accept it (the program closed it);
 * waiting: with the owner or the trusted people; declined: the owner said no; approved: approved, not yet paid
 * (e.g. an objection window); paid.
 */
export function askStatus(claim: Claim, estate: Pick<Estate, "status" | "claimThreshold"> & Partial<Pick<Estate, "verifiers">>, note?: AskNote | null): AskStatus {
  if (claim.status === "Paid") return "paid";
  if (claim.status === "Rejected") return "refused";
  if (claim.agentVerdict === "Pending") return "checking";
  // The owner's "no" stands after the death too (H9).
  if (note?.declinedAt && !claim.ownerApproved) return "declined";
  // Only votes given after the death, by seats still held, not by the claimant (R3, R8, R11).
  const quorum = estate.status === "Unlocked" && quorumOf({
    verifiers: estate.verifiers ?? ["seat 1", "seat 2", "seat 3"], votes: claim.approvalsCount === false ? [] : claim.approvals,
    threshold: estate.claimThreshold, verdict: claim.agentVerdict, interested: claim.beneficiary,
  }).met;
  if (claim.ownerApproved || quorum) return "approved";
  if (note?.declinedAt) return "declined";
  return "waiting";
}

/** Requests the owner can approve right now (Active, living rule, cleared by the agent, not declined, not paid). */
export function ownerCanDecide(snap: EstateSnapshot, claim: Claim): boolean {
  const rule = snap.rules.find((r) => r.address === claim.rule);
  if (snap.estate.status !== "Active" || !rule?.startsNow) return false;
  if (claim.status !== "Open" || !openToPeople(claim.agentVerdict) || claimBlock(snap, claim)) return false;
  return !snap.asks?.[claim.address]?.declinedAt;
}
