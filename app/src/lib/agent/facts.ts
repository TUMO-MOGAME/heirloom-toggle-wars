/**
 * EstateFacts: a compact, JSON-safe, personal-data-free view of an EstateSnapshot that the UI (or the server
 * in chain mode) hands to the orchestrator's specialists as tool data. Client-safe.
 */
// The zod schema lives in ./facts-schema (the orchestrate route checks with it), so the agent sheet, which only
// builds facts, never downloads zod.
import type { z } from "zod";
import type { estateFactsSchema } from "./facts-schema";
import type { EstateSnapshot } from "../service/types";
import { eligibleSeats } from "../death-rules";
import { fromBase } from "../format";

export type EstateFacts = z.infer<typeof estateFactsSchema>;

export function toEstateFacts(s: EstateSnapshot): EstateFacts {
  const label = (w: string) => s.beneficiaries.find((b) => b.wallet === w)?.label ?? w.slice(0, 6);
  // As the program counts: held seats only, never the vote of whoever would gain.
  const given = (votes: boolean[], interested: string | null) => eligibleSeats(s.estate.verifiers, interested).filter((i) => votes[i]).length;
  // A removed family member can't claim or be paid, so the agent isn't told they can.
  const removed = new Set(s.beneficiaries.filter((b) => !b.active).map((b) => b.wallet));
  const a = s.assets[0];
  return {
    estate: {
      address: s.estate.address, status: s.estate.status, ownerName: s.estate.ownerName, vaultUsdt: fromBase(s.estate.vaultBalance),
      verifierNames: s.estate.verifierNames.filter(Boolean),
      waitingPeriodSecs: s.estate.waitingPeriodSecs, deathThreshold: s.estate.deathThreshold,
      claimThreshold: s.estate.claimThreshold, hardshipThreshold: s.estate.hardshipThreshold,
      death: { verdict: s.estate.death.verdict, attestations: given(s.estate.death.attestations, s.estate.death.submittedBy), pendingSince: s.estate.death.pendingSince },
    },
    beneficiaries: s.beneficiaries.filter((b) => b.active).map((b) => ({ wallet: b.wallet, label: b.label })),
    payees: s.payees.map((p) => ({ wallet: p.wallet, name: p.name, kind: p.kind })),
    rules: s.rules.filter((r) => !removed.has(r.beneficiary)).map((r) => ({
      address: r.address, id: r.id, beneficiary: r.beneficiary, beneficiaryLabel: label(r.beneficiary), category: r.category,
      allowedPayeeKind: r.allowedPayeeKind, maxPerClaimUsdt: fromBase(r.maxPerClaim), lifetimeCapUsdt: fromBase(r.lifetimeCap),
      spentUsdt: fromBase(r.spentTotal), remainingUsdt: fromBase(r.lifetimeCap - r.spentTotal), validUntil: r.validUntil, startsNow: r.startsNow,
    })),
    claims: s.claims.slice(0, 20).map((c) => ({
      address: c.address, rule: c.rule, amountUsdt: fromBase(c.amount),
      status: c.status !== "Open" ? c.status
        : c.fromEndedRule ? "Cannot be paid: its rule ended and was replaced"
          : removed.has(c.beneficiary) ? "Cannot be paid: this person is no longer in the plan" : c.status,
      agentVerdict: c.agentVerdict,
      approvals: c.approvalsCount === false ? 0 : given(c.approvals, c.beneficiary), redFlags: c.agentReport?.redFlags,
    })),
    asset: a ? {
      address: a.address, title: a.title, status: a.status, floorUsdt: fromBase(a.floorPrice), hardshipFloorUsdt: fromBase(a.hardshipFloor),
      askingUsdt: fromBase(a.askingPrice), hardshipApproved: a.hardshipBeneficiary !== null, listingEnds: a.listingEnds,
    } : null,
    offers: s.offers.map((o) => ({ address: o.address, buyer: o.buyerName ?? o.buyer.slice(0, 6), amountUsdt: fromBase(o.amount), createdAt: o.createdAt })),
    hardships: s.hardships.map((h) => ({ address: h.address, status: h.status, agentVerdict: h.agentVerdict, approvals: given(h.approvals, h.beneficiary) })),
    recentActivity: s.activity.slice(0, 10).map((x) => x.text),
  };
}

/** Deterministic claim pre-check (mirrors submit_claim's on-chain checks). Pure; unit-tested. */
export function checkClaim(facts: EstateFacts, ruleId: number, amountUsdt: number, payeeWallet?: string, nowSecs = Math.floor(Date.now() / 1000)):
  { ok: boolean; problems: string[]; maxAllowedUsdt: number } {
  const rule = facts.rules.find((r) => r.id === ruleId);
  if (!rule) return { ok: false, problems: [`There is no rule #${ruleId}.`], maxAllowedUsdt: 0 };
  const problems: string[] = [];
  const maxAllowed = Math.max(0, Math.min(rule.maxPerClaimUsdt, rule.remainingUsdt));
  const owner = facts.estate.ownerName.split(" ")[0] || "the owner";
  if (facts.estate.status === "DeathPending") problems.push(`${owner}'s passing has been confirmed and the waiting period is running. Claims open when it ends.`);
  else if (facts.estate.status === "Active" && !rule.startsNow) problems.push(`This rule can only be claimed after ${owner}'s passing is confirmed. While ${owner} is alive, only rules marked "Live now" can be claimed.`);
  else if (facts.estate.status !== "Unlocked" && facts.estate.status !== "Active") problems.push(`The estate is ${facts.estate.status}, so claims are paused.`);
  if (amountUsdt <= 0) problems.push("The amount must be more than zero.");
  if (amountUsdt > rule.maxPerClaimUsdt) problems.push(`The per-claim cap is ${rule.maxPerClaimUsdt} USD₮.`);
  if (amountUsdt > rule.remainingUsdt) problems.push(`Only ${rule.remainingUsdt} USD₮ is left under the lifetime cap.`);
  if (nowSecs > rule.validUntil) problems.push("This rule has expired.");
  if (payeeWallet) {
    const payee = facts.payees.find((p) => p.wallet === payeeWallet);
    if (!payee) problems.push("That payee is not approved for this estate.");
    else if (payee.kind !== rule.allowedPayeeKind) problems.push(`This rule only pays a ${rule.allowedPayeeKind}, not a ${payee.kind}.`);
  }
  return { ok: problems.length === 0, problems, maxAllowedUsdt: maxAllowed };
}
