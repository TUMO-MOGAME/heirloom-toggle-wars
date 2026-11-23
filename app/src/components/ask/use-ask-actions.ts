"use client";
/**
 * The owner's two answers to a request, shared by the chat home card and the Claims screen.
 * Approve goes through the payment review (owner_approve_claim, then execute_claim pays the approved payee); decline is
 * the off-chain "no" (lib/ask/types.ts).
 */
import { useCallback } from "react";
import { ask as askEnglish } from "@/content/ask";
import { useLocalized } from "@/lib/i18n/client";
import { useEstate } from "@/lib/hooks/estate";
import { formatUsdt } from "@/lib/format";
import { usePay } from "@/components/pay/payment";
import { fmt } from "@/components/shell/copy";

export function useAskActions() {
  const { snap, run } = useEstate();
  const { pay } = usePay();
  const c = useLocalized(askEnglish, (t) => t.ask);

  const approve = useCallback((claimAddr: string) => {
    const claim = snap?.claims.find((x) => x.address === claimAddr);
    if (!snap || !claim) return;
    const payee = snap.payees.find((p) => p.wallet === claim.payee)?.name ?? snap.names?.[claim.payee] ?? "";
    const low = snap.estate.vaultBalance < claim.amount ? [fmt(c.sheet.vaultLow, { vault: formatUsdt(snap.estate.vaultBalance, { decimals: 0 }) })] : undefined;
    // Skip the approval if it already went through on an earlier attempt (the program refuses a second one); tracked
    // here too, because "Try again" re-runs this before the snapshot refreshes.
    let approved = claim.ownerApproved;
    void pay({
      kind: "claim-payout", source: "vault", to: claim.payee, toLabel: payee, amount: claim.amount, warnings: low, ...(claim.ownerApproved ? {} : { approve: "owner" as const, claim: claim.address }),
      execute: async (svc, est, again) => {
        // A first try that was still being checked may have approved it: read it again rather than approve twice.
        if (!approved && again) approved = !!(await svc.getEstate(est)).claims.find((x) => x.address === claim.address)?.ownerApproved;
        if (!approved) { await svc.ownerApproveClaim(est, claim.address); approved = true; }
        return svc.executeClaim(est, claim.address);
      },
      successText: fmt(c.nudges.paidToast, { payee }),
    });
  }, [snap, pay, c]);

  const decline = useCallback((claimAddr: string) => {
    const claim = snap?.claims.find((x) => x.address === claimAddr);
    if (!snap || !claim) return Promise.resolve(false);
    const label = snap.beneficiaries.find((b) => b.wallet === claim.beneficiary)?.label ?? "";
    const name = label.split(/[ (]/)[0] || label;
    return run(`decline:${claimAddr}`, (svc, est) => svc.declineAsk(est, claimAddr), fmt(c.nudges.declinedToast, { name })).then((r) => r.ok);
  }, [snap, run, c]);

  return { approve, decline };
}
