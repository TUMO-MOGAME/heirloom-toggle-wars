"use client";
/**
 * Disputes (U9). `DisputePanel`: on a pending claim or the pending unlock, the dispute (if any) or, for a family
 * member or trusted person, "Dispute this" with a written reason (only its hash goes on-chain; it pauses the step).
 * `DisputeCard`: who disputed, why, the votes, when it lapses, and Uphold / Dismiss for the trusted people.
 * `DisputeList`: disputes a trusted person can still decide (Inbox).
 */
import { useId, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Gavel, Pause } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { Base58 } from "@/lib/types";
import { disputeOn, effectiveStatus, type Dispute, type DisputeKind } from "@/lib/disputes/types";
import { deathSince, interestedIn, isHeld } from "@/lib/guardians/decisions";
import { formatUsdt, shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Badge, Button, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { ActionResult, useAction, useWaitText } from "@/components/guardians/parts";
import { clock, objectionOver } from "@/components/guardians/derive";

export const MIN_DISPUTE_REASON = 10;

/** May `me` raise a dispute on `target` now? Mirrors raise_dispute (the program has the final word). */
export function canDispute(snap: EstateSnapshot, me: Base58 | undefined, kind: DisputeKind, target: Base58, now: number | null = null): boolean {
  if (!me || me === interestedIn(snap, kind, target)) return false;
  const e = snap.estate;
  const allowed = (isHeld(me) && e.verifiers.includes(me)) || snap.beneficiaries.some((b) => b.wallet === me && b.active);
  if (!allowed) return false;
  // One challenge at a time per target (shared with monitors' objections), one per claim / per waiting period.
  const since = deathSince(e);
  if (snap.guardians?.objections.some((o) => o.target === target && (
    kind === "Claim" || (o.status === "Open" && !objectionOver(o, now)) || (o.status !== "Upheld" && o.raisedAt >= since)
  ))) return false;
  const prev = disputeOn(snap.disputes, target);
  if (kind === "Claim") return !prev && snap.claims.some((c) => c.address === target && c.status === "Open");
  if (e.status !== "DeathPending") return false;
  return !prev || prev.status === "Upheld" || prev.raisedAt < since;
}

/** A trusted person who may still vote on this dispute. */
export function canResolve(snap: EstateSnapshot, me: Base58 | undefined, d: Dispute, now: number | null): boolean {
  if (!me || now === null || effectiveStatus(d, now) !== "Open") return false;
  const i = snap.estate.verifiers.indexOf(me);
  return i >= 0 && me !== d.disputer && !d.voted.includes(i);
}

/** The dispute on a pending claim or unlock, or the button to raise one. Renders nothing when neither applies. */
export function DisputePanel({ kind, target, className }: { kind: DisputeKind; target: Base58; className?: string }) {
  const { snap, session } = useEstate();
  const now = useNow(5000);
  if (!snap) return null;
  const d = disputeOn(snap.disputes, target);
  const current = d && (kind === "Claim" || d.raisedAt >= (snap.estate.death.pendingSince ?? 0) || d.status === "Open") ? d : null;
  if (current) return <DisputeCard dispute={current} className={className} />;
  if (!canDispute(snap, session?.address, kind, target, now)) return null;
  return <div className={className}><RaiseDispute kind={kind} target={target} /></div>;
}

/** "Dispute this" → reason form. Consent required: the written reason is personal information kept off-chain. */
export function RaiseDispute({ kind, target }: { kind: DisputeKind; target: Base58 }) {
  const { common, disputes: c } = useCopy();
  const { snap } = useEstate();
  const r = c.raise;
  const id = useId();
  const wait = useWaitText();
  const { act, busy, refusal, receipt } = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `dispute-${target}`;
  const period = wait(Math.max(snap?.estate.waitingPeriodSecs ?? 60, 60));

  if (!open) {
    return (
      <>
        <Button variant="secondary" small onClick={() => setOpen(true)}><Gavel className="size-4" aria-hidden="true" />{kind === "Unlock" ? r.ctaUnlock : r.cta}</Button>
        <ActionResult receipt={receipt} refusal={refusal} />
      </>
    );
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (reason.trim().length < MIN_DISPUTE_REASON) { setError(r.needReason); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await act(key, (s, est) => s.raiseDispute(est, { kind, target, reason: reason.trim() }), r.done);
    if (res.ok) { setOpen(false); setReason(""); setConsent(false); }
  };

  const reasonError = error === r.needReason;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-md border-2 border-ink bg-surface p-3">
      <div>
        <p className="font-semibold">{kind === "Claim" ? r.titleClaim : r.titleUnlock}</p>
        <p className="text-small text-ink-2">{fmt(r.body, { period })}</p>
      </div>
      <Field label={r.reason} htmlFor={`${id}-reason`} hint={r.reasonHint} error={reasonError ? error : null}>
        <textarea id={`${id}-reason`} value={reason} maxLength={600} rows={3} onChange={(e) => { setReason(e.target.value); setError(null); }}
          aria-invalid={reasonError || undefined}
          className={clsx(inputClass, "min-h-24 py-2.5")} aria-describedby={reasonError ? `${id}-reason-error` : `${id}-reason-hint`} />
      </Field>
      <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
      {error && !reasonError && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => { setOpen(false); setError(null); }}>{r.cancel}</Button>
        <Button type="submit" className="flex-1" loading={busy === key}><Pause className="size-4" aria-hidden="true" />{r.submit}</Button>
      </div>
      <ActionResult receipt={receipt} refusal={refusal} />
    </form>
  );
}

/** One dispute: who, why, its fingerprint, the votes, the lapse countdown, and Uphold / Dismiss for trusted people. */
export function DisputeCard({ dispute: d, className }: { dispute: Dispute; className?: string }) {
  const { disputes: c } = useCopy();
  const { snap, session } = useEstate();
  const now = useNow();
  const { act, busy, receipt, refusal } = useAction();
  if (!snap) return null;
  const t = c.card;
  const status = now === null ? d.status : effectiveStatus(d, now);
  const claim = d.kind === "Claim" ? snap.claims.find((x) => x.address === d.target) : undefined;
  const payee = claim ? snap.payees.find((p) => p.wallet === claim.payee)?.name ?? shortAddress(claim.payee) : "";
  const about = d.kind === "Claim" ? (claim ? fmt(t.aboutClaim, { amount: formatUsdt(claim.amount), payee }) : "") : t.aboutUnlock;
  const me = session?.address;
  const myIndex = me ? snap.estate.verifiers.indexOf(me) : -1;
  const mayVote = canResolve(snap, me, d, now);
  const key = `resolve-${d.address}`;
  const left = now === null ? null : Math.max(0, d.lapsesAt - now);

  return (
    <article aria-label={t.title} className={clsx("rounded-md bg-surface p-3", status === "Open" ? "border-2 border-l-8 border-ink" : "border-[1.5px] border-ink", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Gavel className="size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 font-semibold">{fmt(t.by, { name: d.disputerName })}</p>
        <Badge tone={status === "Open" ? "warn" : status === "Upheld" ? "danger" : "ok"}>{t.status[status]}</Badge>
      </div>
      {about && <p className="mt-1 text-small">{about}</p>}
      <div className="mt-2">
        <p className="text-small font-semibold">{t.reason}</p>
        {d.reason
          ? <blockquote className="mt-0.5 break-words border-l-4 border-line-strong pl-3 text-small">{d.reason}</blockquote>
          : <p className="mt-0.5 text-small text-ink-2">{t.noReason}</p>}
        <p className="mt-1 text-[0.75rem] text-ink-2">{t.fingerprint}: <span className="font-mono">{shortAddress(d.reasonHash, 6)}</span></p>
      </div>
      {status === "Open" ? (
        <>
          <p className="mt-2 text-small tabular-nums">{fmt(t.votes, { up: d.votesUphold, down: d.votesDismiss })}</p>
          {left !== null && <p className="text-small text-ink-2 tabular-nums">{fmt(t.lapses, { time: clock(left) })}</p>}
          {mayVote ? (
            <>
              <p className="mt-1 text-small text-ink-2">{t.youDecide}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {/* Nobody dismisses a challenge in their own favour. */}
                {me !== interestedIn(snap, d.kind, d.target) && <Button variant="secondary" className="flex-1" loading={busy === `${key}-down`} disabled={!!busy} onClick={() => void act(`${key}-down`, (s, est) => s.resolveDispute(est, d.address, false), t.dismissed)}>{t.dismiss}</Button>}
                <Button className="flex-1" loading={busy === `${key}-up`} disabled={!!busy} onClick={() => void act(`${key}-up`, (s, est) => s.resolveDispute(est, d.address, true), t.upheld)}>{t.uphold}</Button>
              </div>
            </>
          ) : myIndex >= 0 && d.voted.includes(myIndex) ? <p className="mt-1 text-small">{t.voted}</p> : null}
        </>
      ) : (
        <Notice tone={status === "Upheld" ? "danger" : "ok"} className="mt-2"><p>{t.outcome[d.kind][status]}</p></Notice>
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </article>
  );
}

/** Disputes this trusted person can still decide (Inbox). Renders nothing when there are none. */
export function DisputeList({ snap, className }: { snap: EstateSnapshot; className?: string }) {
  const { disputes: c } = useCopy();
  const { session } = useEstate();
  const now = useNow(15000);
  const list = (snap.disputes ?? []).filter((d) => canResolve(snap, session?.address, d, now));
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="disputes-title" className={className}>
      <h2 id="disputes-title" className="flex items-center gap-2 text-h3"><Gavel className="size-5" aria-hidden="true" />{c.list.title}</h2>
      <ul className="mt-3 flex flex-col gap-3">{list.map((d) => <li key={d.address}><DisputeCard dispute={d} /></li>)}</ul>
    </section>
  );
}

/** Number of disputes waiting for this trusted person's vote (Inbox badge). */
export function disputesToDecide(snap: EstateSnapshot | null, me: Base58 | undefined, now: number | null): number {
  return snap ? (snap.disputes ?? []).filter((d) => canResolve(snap, me, d, now)).length : 0;
}
