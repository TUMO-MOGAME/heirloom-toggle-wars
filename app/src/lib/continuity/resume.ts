/** Signing a plan again after it was interrupted: which of its rules are not on the chain yet. Pure. */
import { toBase } from "../format";
import type { Rule, WillDraft } from "../types";

export function rulesStillToAdd(
  wanted: WillDraft["rules"],
  people: WillDraft["beneficiaries"],
  onChain: Pick<Rule, "beneficiary" | "category" | "allowedPayeeKind" | "maxPerClaim" | "lifetimeCap" | "validUntil" | "startsNow">[],
): WillDraft["rules"] {
  const left = [...onChain];
  return wanted.filter((w) => {
    const wallet = people.find((p) => p.label === w.beneficiaryLabel)?.wallet;
    const at = left.findIndex((r) => r.beneficiary === wallet && r.category === w.category && r.allowedPayeeKind === w.allowedPayeeKind
      && r.maxPerClaim === toBase(w.maxPerClaimUsdt) && r.lifetimeCap === toBase(w.lifetimeCapUsdt)
      && r.startsNow === w.startsNow && r.validUntil === Math.floor(Date.parse(w.validUntil) / 1000));
    if (at < 0) return true;
    left.splice(at, 1); // two identical rules need two on the chain
    return false;
  });
}
