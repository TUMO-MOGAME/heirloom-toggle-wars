"use client";
/**
 * The sale's co-signature (plan §18.4 U4, R12, R19): the trusted person reads the buyer and the exact amount, then
 * signs that. An offer that changed in the meantime is shown again and is never signed on the old reading.
 */
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { PenLine, Gavel } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { SeenOffer } from "@/lib/service/types";
import type { Asset, Offer, OfferRanking } from "@/lib/types";
import { hasLivingSeat, isHeld } from "@/lib/guardians/decisions";
import { bestWaiting, clockTime, offerWait } from "@/lib/assets/sale-wait";
import { useLocale } from "@/lib/i18n/client";
import { useNow } from "@/lib/hooks/use-now";
import { clock } from "@/components/guardians/derive";
import { useEstate } from "@/lib/hooks/estate";
import { formatUsdtExact } from "@/lib/format";
import { Button } from "@/components/ui/primitives";
import { Blocked } from "@/components/shell/blocked";
import { fmt, useCopy } from "@/components/shell/copy";
import { useWho } from "@/components/guardians/decision";

/** Every decimal there is: what is signed is what is read. */
export const exactUsdt = (base: bigint) => formatUsdtExact(base);

const changed = () => Object.assign(new Error("OfferChanged: the offer changed after it was shown."), { code: "OfferChanged" });

export function CoSign({ snap, asset, ranking, body, cta, working, done, refusalExtra }: {
  snap: EstateSnapshot;
  asset: Asset;
  ranking: OfferRanking | null;
  body: string;
  cta: string;
  working: string;
  done: string;
  refusalExtra?: ReactNode;
}) {
  const t = useCopy().guardians.rules.sale;
  const { session, run, busy } = useEstate();
  const who = useWho(snap);
  const id = useId();
  const [seen, setSeen] = useState<SeenOffer | null>(null);
  const [moved, setMoved] = useState(false);
  const [blocked, setBlocked] = useState<{ code: string; message: string } | null>(null);
  const e = snap.estate;
  const me = session?.address;
  const mine = snap.offers.filter((o) => o.asset === asset.address);
  const best: Offer | undefined = mine.find((o) => o.address === ranking?.bestOffer);
  const staffed = hasLivingSeat(e);
  const holder = isHeld(me) && e.verifiers.includes(me);
  const ownOffer = holder && !!best && best.buyer === me;
  const now = useNow();
  const locale = useLocale();
  // Nothing acceptable yet, but an offer only waits out its objection window: say from when, and wait for it.
  const pending = !best && asset.status === "Listed" ? bestWaiting(ranking) : null;
  const pendingOffer = pending ? mine.find((o) => o.address === pending.offer) : undefined;
  const g = snap.guardians;
  const pendingWhy = pendingOffer ? offerWait(ranking, pendingOffer, { asset, objections: g?.objections, windowSecs: g?.enabled ? g.objectionWindowSecs : null }) : null;

  const to = asset.hardshipBeneficiary ?? asset.proceedsTo;
  if (seen && (seen.offer !== best?.address || seen.amount !== best.amount || seen.recipient !== to)) {
    // A change is shown and has to be read again: the offer, the amount or who gets the money (H11).
    setSeen(best ? { offer: best.address, amount: best.amount, recipient: to } : null);
    setMoved(true);
  }

  const sign = async (agreed: SeenOffer | null) => {
    setBlocked(null);
    const res = await run("settle", async (s, est) => {
      if (!agreed) return s.acceptBestOffer(est, asset.address, null);
      const [latest, now] = await Promise.all([s.rankOffers(asset.address), s.getEstate(est)]);
      const fresh = now.assets.find((x) => x.address === asset.address);
      if (latest.bestOffer !== agreed.offer || now.offers.find((o) => o.address === agreed.offer)?.amount !== agreed.amount
        || (fresh?.hardshipBeneficiary ?? fresh?.proceedsTo) !== agreed.recipient) throw changed();
      return s.acceptBestOffer(est, asset.address, agreed);
    }, done, true);
    if (res.ok) { setSeen(null); setMoved(false); return; }
    if (res.code === "OfferChanged" || res.code === "sale_changed") setMoved(true);
    else setBlocked({ code: res.code, message: res.message });
  };

  if (ownOffer) return <p className="mt-2 text-small font-semibold">{t.ownOffer}</p>;

  return (
    <>
      <p className="mt-1 text-ink-2">{staffed ? body : t.noSeats}</p>
      {moved && <p role="alert" className="mt-3 border-l-4 border-ink pl-2 text-small font-semibold">{best ? t.changed : t.noOffer}</p>}
      {seen && best ? (
        <div role="group" aria-labelledby={`${id}-title`} className="mt-3 rounded-md border-2 border-ink p-3">
          <p id={`${id}-title`} className="font-semibold">{staffed ? t.title : t.settleTitle}</p>
          <dl className="mt-2 grid gap-2 text-small">
            <div className="min-w-0">
              <dt className="text-ink-2">{t.buyer}</dt>
              <dd className="font-semibold">{best.buyerName ?? who(best.buyer)}</dd>
              <dd className="break-all font-mono text-[0.75rem] text-ink-2">{best.buyer}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-2">{t.amount}</dt>
              <dd className="break-words text-h3 font-semibold tabular-nums">{exactUsdt(seen.amount)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-2">{t.to}</dt>
              <dd className="font-semibold">{to === e.address ? t.vault : who(to)}</dd>
              {to !== e.address && <dd className="break-all font-mono text-[0.75rem] text-ink-2">{to}</dd>}
            </div>
          </dl>
          <p className="mt-2 text-small text-ink-2">{staffed ? t.body : t.noSeats}</p>
          {staffed && <p className="mt-1 text-small font-semibold">{t.expires}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="ghost" autoFocus onClick={() => { setSeen(null); setMoved(false); }}>{t.back}</Button>
            <Button className="flex-1" loading={busy === "settle"} disabled={!!busy} onClick={() => void sign(seen)}>
              <PenLine className="size-5 shrink-0" aria-hidden="true" />{busy === "settle" ? working : fmt(staffed ? t.sign : t.settle, { amount: exactUsdt(seen.amount) })}
            </Button>
          </div>
        </div>
      ) : (
        <>
        {pending && (
          <div className="mt-3 rounded-md border-[1.5px] border-dashed border-ink p-3 text-small">
            <p className="font-semibold tabular-nums" role="timer" aria-live="off">
              {now === null ? "" : fmt(t.notYet, { time: clockTime(pending.readyAt, now, locale), left: clock(Math.max(0, pending.readyAt - now)) })}
            </p>
            <p className="mt-1 text-ink-2">{pendingWhy?.kind === "window" && pendingWhy.why === "hardship" ? t.whyHardship : t.whyOffer}</p>
          </div>
        )}
        <Button
          className="mt-3" loading={busy === "settle" || (mine.length > 0 && !ranking)} disabled={!!busy || mine.length === 0 || !!pending}
          // With no offer that can win there is nothing to read: asking shows the contract's refusal and why.
          onClick={() => {
            setMoved(false);
            if (best) { setBlocked(null); setSeen({ offer: best.address, amount: best.amount, recipient: to }); } else void sign(null);
          }}
        >
          <Gavel className="size-5" aria-hidden="true" />{busy === "settle" ? working : best ? t.review : cta}
        </Button>
        </>
      )}
      {blocked && <div className="mt-4"><Blocked code={blocked.code} message={blocked.message}>{refusalExtra}</Blocked></div>}
    </>
  );
}
