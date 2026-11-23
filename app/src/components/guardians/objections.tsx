"use client";
/**
 * Monitors and objections. `MonitorFeed`: a watcher sees every approval by the trusted person they watch and can raise
 * an objection (only a hash of the reason goes on-chain; it pauses the payment). `ObjectionCard`: the objection, who
 * raised it, the reason, Uphold / Dismiss for those who may vote, and the outcome.
 */
import { useId, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Gavel, Pause, Search } from "@/components/ui/icons";
import type { Objection, SeatApprovalItem, TargetKind } from "@/lib/guardians/types";
import type { Base58 } from "@/lib/types";
import type { EstateSnapshot } from "@/lib/service";
import { shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Badge, Button, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt, timeAgo, useCopy } from "@/components/shell/copy";
import { canObject, clock, feedFor, objectionFor, objectionOver, secondsLeft, shortName, voterRole, watchedSeats } from "./derive";
import { interestedIn } from "@/lib/guardians/decisions";
import { ActionResult, useAction, useGuardians } from "./parts";

export const MIN_REASON = 10;

/** Reason form. Consent required: the written reason is personal information kept off-chain. */
export function RaiseObjection({ kind, target, seatIndex, onDone }: { kind: TargetKind; target: Base58; seatIndex: number | null; onDone?: () => void }) {
  const { common, guardians: c } = useCopy();
  const o = c.object;
  const id = useId();
  const { act, busy, refusal, receipt } = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `object-${target}`;

  if (!open) {
    return (
      <>
        <Button variant="secondary" small onClick={() => setOpen(true)}><Gavel className="size-4" aria-hidden="true" />{c.feed.object}</Button>
        <ActionResult receipt={receipt} refusal={refusal} />
      </>
    );
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (reason.trim().length < MIN_REASON) { setError(o.needReason); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await act(key, (s, est) => s.raiseObjection(est, { kind, target, seatIndex, reason: reason.trim() }), o.done);
    if (res.ok) { setOpen(false); setReason(""); onDone?.(); }
  };

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3 rounded-md border-2 border-ink bg-surface p-3">
      <div>
        <p className="font-semibold">{o.title}</p>
        <p className="text-small text-ink-2">{o.body}</p>
      </div>
      <Field label={o.reason} htmlFor={`${id}-reason`} hint={o.reasonHint} error={error === o.needReason ? error : null}>
        <textarea id={`${id}-reason`} value={reason} maxLength={600} rows={3} onChange={(e) => { setReason(e.target.value); setError(null); }}
          className={clsx(inputClass, "min-h-24 py-2.5")} aria-describedby={error === o.needReason ? `${id}-reason-error` : `${id}-reason-hint`} />
      </Field>
      <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
      {error && error !== o.needReason && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => { setOpen(false); setError(null); }}>{c.cancel}</Button>
        <Button type="submit" className="flex-1" loading={busy === key}><Pause className="size-4" aria-hidden="true" />{o.submit}</Button>
      </div>
      <ActionResult receipt={receipt} refusal={refusal} />
    </form>
  );
}

/** "Approvals by Uncle Bongani": one section per trusted person this wallet watches. */
export function MonitorFeed({ className }: { className?: string }) {
  const { guardians: c, common } = useCopy();
  const { session } = useEstate();
  const g = useGuardians();
  const now = useNow();
  const seats = watchedSeats(g, session?.address);
  if (!g || seats.length === 0) return null;
  const feed = feedFor(g, session?.address);
  const f = c.feed;

  return (
    <div className={clsx("grid gap-4", className)}>
      {seats.map((seat) => {
        const name = shortName(seat.holderName);
        const items = feed.filter((x) => x.seatIndex === seat.index);
        return (
          <section key={seat.index} aria-labelledby={`feed-${seat.index}`} className="rounded-xl border border-line bg-surface p-4 sm:p-5">
            <h2 id={`feed-${seat.index}`} className="flex items-center gap-2 text-h3"><Search className="size-5" aria-hidden="true" />{fmt(f.title, { name })}</h2>
            <p className="mt-1 text-ink-2">{fmt(f.body, { name })}</p>
            {items.length === 0 ? <p className="mt-3 text-small">{fmt(f.empty, { name })}</p> : (
              <ul className="mt-3 flex flex-col gap-3">
                {items.map((it) => <FeedItem key={`${it.target}-${it.ts}`} item={it} now={now} timeLabel={timeAgo(it.ts, now, common.time)} />)}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FeedItem({ item, now, timeLabel }: { item: SeatApprovalItem; now: number | null; timeLabel: string }) {
  const { guardians: c } = useCopy();
  const g = useGuardians();
  const f = c.feed;
  const { snap, session } = useEstate();
  const objection = objectionFor(g, item.target);
  const open = !!snap && canObject(g, item, now, { snap, wallet: session?.address });
  const left = secondsLeft(item.objectionDeadline, now);
  return (
    <li className={clsx("rounded-md border p-3", open ? "border-[1.5px] border-dashed border-ink" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={open ? "warn" : "neutral"}>{f.kinds[item.kind]}</Badge>
        {open && <Badge tone="gold">{f.badge}</Badge>}
        {objection && <Badge tone={objection.status === "Open" && !objectionOver(objection, now) ? "danger" : "ok"}>{objectionOver(objection, now) ? c.objection.status.Lapsed : c.objection.status[objection.status]}</Badge>}
      </div>
      <p className="mt-1.5 font-semibold">{item.summary}</p>
      <p className="text-small text-ink-2">{fmt(f.when, { when: timeLabel })}</p>
      {objection && <ObjectionCard objection={objection} compact className="mt-3" />}
      {open ? (
        <>
          {left !== null && <p className="mt-1 text-small tabular-nums">{fmt(f.deadline, { time: clock(left) })}</p>}
          <div className="mt-2"><RaiseObjection kind={item.kind} target={item.target} seatIndex={item.seatIndex} /></div>
        </>
      ) : objection ? null : <p className="mt-1 text-small text-ink-2">{f.closed}</p>}
    </li>
  );
}

/** One objection: who, why, its fingerprint, the votes, and Uphold / Dismiss for those who may decide. */
export function ObjectionCard({ objection: o, compact = false, what, className }: { objection: Objection; compact?: boolean; what?: string; className?: string }) {
  const { guardians: c, disputes } = useCopy();
  const { session, snap } = useEstate();
  const g = useGuardians();
  const { act, busy, receipt, refusal } = useAction();
  const now = useNow(5000);
  if (!snap) return null;
  const t = c.objection;
  const voter = voterRole(g, o, snap, session?.address, now);
  const over = objectionOver(o, now);
  // Nobody dismisses a challenge in their own favour; upholding is theirs to do.
  const ownGain = voter !== "owner" && !!voter && session?.address === interestedIn(snap, o.kind, o.target);
  const watched = o.seatIndex !== null ? g?.seats.find((s) => s.index === o.seatIndex) : undefined;
  const subject = what ?? g?.feed.find((f) => f.target === o.target)?.summary ?? c.feed.kinds[o.kind];
  const key = `vote-${o.address}`;

  return (
    <article aria-label={t.title} className={clsx("rounded-md bg-surface p-3", o.status === "Open" && !over ? "border-2 border-l-8 border-ink" : "border-[1.5px] border-ink", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Gavel className="size-4" aria-hidden="true" />
        <p className="font-semibold">{fmt(t.by, { name: o.monitorName })}</p>
        <Badge tone={o.status === "Open" && !over ? "warn" : o.status === "Upheld" ? "danger" : "ok"}>{over ? t.status.Lapsed : t.status[o.status]}</Badge>
      </div>
      {!compact && <p className="mt-1 text-small">{fmt(t.about, { what: subject })}{watched ? ` · ${watched.holderName}` : ""}</p>}
      <div className="mt-2">
        <p className="text-small font-semibold">{t.reason}</p>
        {o.reason
          ? <blockquote className="mt-0.5 break-words border-l-4 border-line-strong pl-3 text-small">{o.reason}</blockquote>
          : <p className="mt-0.5 text-small text-ink-2">{disputes.card.noReason}</p>}
        <p className="mt-1 text-[0.75rem] text-ink-2">{t.fingerprint}: <span className="font-mono">{shortAddress(o.reasonHash, 6)}</span></p>
      </div>
      {o.status === "Open" ? (
        <>
          <p className="mt-2 text-small tabular-nums">{fmt(t.votes, { up: o.votesUphold, down: o.votesDismiss })}</p>
          {voter && (
            <>
              <p className="mt-1 text-small text-ink-2">{voter === "owner" ? t.ownerDecides : voter === "monitor" ? t.monitorsDecide : t.twoDecide}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {!ownGain && <Button variant="secondary" className="flex-1" loading={busy === `${key}-down`} disabled={!!busy} onClick={() => void act(`${key}-down`, (s, est) => s.voteObjection(est, o.address, false), t.dismissed)}>{t.dismiss}</Button>}
                <Button className="flex-1" loading={busy === `${key}-up`} disabled={!!busy} onClick={() => void act(`${key}-up`, (s, est) => s.voteObjection(est, o.address, true), t.upheld)}>{t.uphold}</Button>
              </div>
            </>
          )}
        </>
      ) : (
        <Notice tone={o.status === "Upheld" ? "danger" : "ok"} className="mt-2"><p>{t.outcome[o.status]}</p></Notice>
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </article>
  );
}

/** All objections on the estate, open first. Used on People (everyone) and in the Inbox (those who decide). */
export function ObjectionList({ snap, onlyVotable = false, title, className }: { snap: EstateSnapshot; onlyVotable?: boolean; title?: string; className?: string }) {
  const { guardians: c } = useCopy();
  const { session } = useEstate();
  const g = useGuardians();
  const now = useNow(5000);
  if (!g || !g.enabled) return null;
  const list = [...g.objections]
    .filter((o) => !onlyVotable || voterRole(g, o, snap, session?.address, now) !== null)
    .sort((a, b) => Number(b.status === "Open") - Number(a.status === "Open") || b.raisedAt - a.raisedAt);
  if (onlyVotable && list.length === 0) return null;
  return (
    <section aria-labelledby="objections-title" className={className}>
      <h2 id="objections-title" className="flex items-center gap-2 text-h3"><Gavel className="size-5" aria-hidden="true" />{title ?? c.objection.listTitle}</h2>
      {list.length === 0 ? <p className="mt-2 text-small text-ink-2">{c.objection.listEmpty}</p> : (
        <ul className="mt-3 flex flex-col gap-3">{list.map((o) => <li key={o.address}><ObjectionCard objection={o} /></li>)}</ul>
      )}
    </section>
  );
}
