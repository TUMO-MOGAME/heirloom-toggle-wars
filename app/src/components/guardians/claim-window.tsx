"use client";
/**
 * In an estate with watchers, a claim the trusted people fully approved is paid only after the objection window
 * (contract: ObjectionWindowOpen). Instead of an error, this shows "Payable in 0:42 (watchers can object until then)",
 * then a Pay now button that runs the usual payment review and receipt.
 */
import { Banknote, Hourglass } from "@/components/ui/icons";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { openDisputeOn } from "@/lib/disputes/types";
import { Button } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { usePay } from "@/components/pay/payment";
import { clock, pausedBy, secondsLeft, waitFraction } from "./derive";
import { CountdownRing, useGuardians } from "./parts";

export function ClaimWindow({ claim, payee, payeeName, amount, successText }: { claim: string; payee: string; payeeName: string; amount: bigint; successText: string }) {
  const { guardians: c } = useCopy();
  const { busy, snap } = useEstate();
  const { pay } = usePay();
  const g = useGuardians();
  const now = useNow();
  if (pausedBy(g, claim, now)) return null; // the PausedNotice above says why
  if (snap && openDisputeOn(snap.disputes, claim, now ?? 0)) return null; // the dispute card above says why
  // The owner's own approval waits for no window.
  const found = snap?.claims.find((c) => c.address === claim);
  const deadline = found?.ownerApproved ? null : g?.claimPayableAt?.[claim] ?? null;
  const left = secondsLeft(deadline, now);
  const waiting = deadline !== null && (left === null || left > 0);
  // Approved alone by the claimant, the only trusted person left: the window is twice as long (DECIDED_ALONE).
  const alone = !!found?.decidedAlone;

  if (g && waiting) {
    return (
      <div className="mt-4 rounded-md border-[1.5px] border-dashed border-ink p-3">
        <div className="flex items-center gap-3">
          <CountdownRing fraction={waitFraction(deadline, g.objectionWindowSecs * (alone ? 2 : 1), now)} />
          <p className="flex items-center gap-2 font-semibold tabular-nums" role="timer" aria-live="off">
            <Hourglass className="size-4 shrink-0" aria-hidden="true" />{fmt(c.window.payableIn, { time: left === null ? "" : clock(left) })}
          </p>
        </div>
        {alone && <p className="mt-2 text-small">{c.rules.vote.aloneClaimDone}</p>}
      </div>
    );
  }
  return (
    <div className="mt-4">
      <p className="text-small">{deadline === null ? c.rules.vote.pay : c.window.ready}</p>
      <Button className="mt-2" disabled={!!busy}
        onClick={() => void pay({ kind: "claim-payout", source: "vault", to: payee, toLabel: payeeName, amount, execute: (s, est) => s.executeClaim(est, claim), successText })}>
        <Banknote className="size-5" aria-hidden="true" />{c.window.payNow}
      </Button>
    </div>
  );
}
