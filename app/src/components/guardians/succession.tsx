"use client";
/**
 * Succession: "Report a trusted person's passing" (certificate → agent report), then the status of a reported passing
 * on that seat: another trusted person confirms → a short wait (the holder can say "I'm still here") → the first
 * backup takes the place.
 */
import { useId, useState, type FormEvent } from "react";
import { Check, FileHeart, HeartPulse, Hourglass, TriangleAlert, UserRoundPlus } from "@/components/ui/icons";
import type { Seat } from "@/lib/guardians/types";
import type { AgentReport } from "@/lib/types";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, Card, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { FilePicker } from "@/components/ui/client";
import { ReportCard, Reviewing } from "@/components/agent/report-card";
import { fmt, useCopy } from "@/components/shell/copy";
import { canConfirm, canReport, clock, secondsLeft, shortName, successionStage, waitFraction } from "./derive";
import { confirmRoute, seatReplace, successionOutcome } from "@/lib/guardians/decisions";
import { seatReviewedHold } from "@/lib/death-rules";
import { ReplaceWhen, useWho } from "./decision";
import { ActionResult, CountdownRing, PausedNotice, useAction, useGuardians } from "./parts";

/** Upload a trusted person's death certificate. Anyone except that person may report it. */
export function ReportPassing({ initialSeat }: { initialSeat?: number }) {
  const { common, guardians: c } = useCopy();
  const { session, snap } = useEstate();
  const g = useGuardians();
  const now = useNow(5000);
  const r = c.report;
  const id = useId();
  const { act, busy, refusal, receipt } = useAction();
  // Participants only, and a reported passing only once its report may be replaced (R6).
  const options = (g?.seats ?? []).filter((s) => !!snap && canReport(snap, s, session?.address, now) && (initialSeat === undefined || s.index === initialSeat));
  const [seatIndex, setSeatIndex] = useState<number | "">(initialSeat ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
  const key = `seat-death-${seatIndex}`;

  if (!g || !g.enabled) return null;
  if (busy === key) return <Reviewing />;
  if (report) {
    const ok = report.verdict === "approve";
    return (
      <Card>
        {ok ? <Notice tone="ok" title={r.sent} /> : (
          <Notice tone="danger" icon={<TriangleAlert className="size-5" aria-hidden="true" />} title={r.rejectedTitle}><p role="alert">{r.rejectedBody}</p></Notice>
        )}
        <div className="mt-3"><ReportCard report={report} /></div>
        <ActionResult receipt={receipt} refusal={null} />
        {!ok && <Button variant="secondary" className="mt-3" onClick={() => { setReport(null); setFile(null); }}>{r.again}</Button>}
      </Card>
    );
  }
  if (options.length === 0) return null;
  const chosen = options.find((s) => s.index === seatIndex);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (seatIndex === "") { setError(r.needPerson); return; }
    if (!file) { setError(r.needFile); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await act(key, (s, est) => s.reportSeatDeath(est, seatIndex, file));
    if (res.ok) setReport(res.value.report);
  };

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-h3"><FileHeart className="size-5" aria-hidden="true" />{r.title}</h2>
      <p className="mt-1 text-ink-2">{r.body}</p>
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
        <Field label={r.person} htmlFor={`${id}-seat`}>
          <select id={`${id}-seat`} value={seatIndex} onChange={(e) => { setSeatIndex(e.target.value === "" ? "" : Number(e.target.value)); setError(null); }} className={inputClass}>
            <option value="">{r.choose}</option>
            {options.map((s) => <option key={s.index} value={s.index}>{s.holderName}</option>)}
          </select>
        </Field>
        {chosen && chosen.backups.length === 0 && <Notice tone="warn"><p>{fmt(r.noBackup, { name: shortName(chosen.holderName) })}</p></Notice>}
        <FilePicker id={`${id}-cert`} label={r.file} hint={r.fileHint} file={file} onFile={(f) => { setFile(f); setError(null); }} samples={r.samples} copy={common.file} />
        <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
        {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
        <Button type="submit">{r.submit}</Button>
      </form>
      <ActionResult receipt={null} refusal={refusal} />
    </Card>
  );
}

/** The state of a reported passing on one seat, with the action this person can take (if any). */
export function SuccessionStatus({ seat }: { seat: Seat }) {
  const { guardians: c } = useCopy();
  const { session, snap } = useEstate();
  const g = useGuardians();
  const now = useNow();
  const { act, busy, receipt, refusal } = useAction();
  const [handedTo, setHandedTo] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const who = useWho(snap);
  const s = seat.succession;
  const t = c.succession;
  const sr = c.rules.seat;
  const me = session?.address;

  if (handedTo) return <Notice tone="ok" className="mt-3" title={fmt(t.nowHolds, { next: handedTo })}><ActionResult receipt={receipt} refusal={null} /></Notice>;
  if (!g || !s || !snap) return null;
  const stage = successionStage(seat, now);
  const name = shortName(seat.holderName);
  const outcome = successionOutcome(snap.estate, seat);
  const next = outcome.kind === "promote" ? shortName(outcome.next.name) : null;
  const ending = outcome.kind === "clear" ? sr.clear : t.vacant;
  const route = confirmRoute(snap.estate, seat);
  const left = secondsLeft(s.readyAt, now);
  const isHolder = me === seat.holder;

  return (
    <div className="mt-3 rounded-md border-[1.5px] border-dashed border-ink bg-surface p-3">
      <p className="font-semibold">{fmt(t.title, { name })}</p>
      <p className="text-small text-ink-2">{fmt(t.reportedBy, { by: who(s.reportedBy) })}</p>
      <PausedNotice target={seat.address} className="mt-2" />

      {isHolder && stage !== "rejected" && (
        <Notice tone="danger" icon={<TriangleAlert className="size-5" aria-hidden="true" />} title={t.stillHere.title} className="mt-3">
          <p className="text-body">{t.stillHere.body}</p>
          <Button className="mt-3" loading={busy === `veto-${seat.index}`} disabled={!!busy} onClick={() => void act(`veto-${seat.index}`, (svc, est) => svc.vetoSeatDeath(est, seat.index), t.stillHere.done)}>
            <HeartPulse className="size-5" aria-hidden="true" />{t.stillHere.cta}
          </Button>
        </Notice>
      )}

      {stage === "reviewing" && <p className="mt-2 text-small">{t.reviewing}</p>}
      {stage === "rejected" && <p className="mt-2 text-small font-semibold">{t.rejected}</p>}
      {s.report && (stage === "rejected" || stage === "confirm") && <div className="mt-3"><ReportCard report={s.report} compact /></div>}

      {stage === "confirm" && (
        canConfirm(snap, seat, me) ? (
          <div className="mt-3">
            <p className="text-small">{route === "family" ? sr.familyBody : t.confirm.body}</p>
            <Button className="mt-2" loading={busy === `confirm-${seat.index}`} disabled={!!busy} onClick={() => void act(`confirm-${seat.index}`, (svc, est) => svc.confirmSeatDeath(est, seat.index), t.confirm.done)}>
              <Check className="size-5" aria-hidden="true" />{t.confirm.cta}
            </Button>
          </div>
        ) : <p className="mt-2 text-small text-ink-2">{sr.route[route]}</p>
      )}
      {(stage === "reviewing" || stage === "confirm") && (
        <>
          <ReplaceWhen times={seatReplace(snap.estate, seat)} who="seat" />
          <p className="mt-1 text-small text-ink-2">{fmt(sr.stands, { time: clock(seatReviewedHold(snap.estate.waitingPeriodSecs)) })}</p>
          {canReport(snap, seat, me, now) && (replacing
            ? <div className="mt-3"><ReportPassing initialSeat={seat.index} /></div>
            : <Button variant="secondary" small className="mt-2" onClick={() => setReplacing(true)}>{c.rules.replace.cta}</Button>)}
        </>
      )}

      {stage === "waiting" && (
        <div className="mt-3 flex items-center gap-3">
          <CountdownRing fraction={waitFraction(s.readyAt, g.successionWaitSecs, now)} />
          <div className="min-w-0">
            <p className="font-semibold tabular-nums" role="timer" aria-live="off">
              {next ? fmt(t.waiting.title, { next, time: left === null ? "" : clock(left) }) : fmt(t.waiting.plain, { time: left === null ? "" : clock(left) })}
            </p>
            {!next && <p className="text-small">{ending}</p>}
            <p className="text-small text-ink-2">{fmt(t.waiting.body, { name })}</p>
          </div>
        </div>
      )}

      {stage === "ready" && (
        <div className="mt-3">
          <p className="flex items-center gap-2 font-semibold"><Hourglass className="size-4" aria-hidden="true" />{t.ready.title}</p>
          <p className="text-small text-ink-2">{next ? fmt(t.ready.body, { next }) : ending}</p>
          <Button className="mt-2" loading={busy === `finalize-${seat.index}`} disabled={!!busy}
            onClick={async () => {
              const res = await act(`finalize-${seat.index}`, (svc, est) => svc.finalizeSuccession(est, seat.index), next ? fmt(t.ready.done, { next }) : outcome.kind === "clear" ? sr.cleared : t.emptied);
              if (res.ok && outcome.kind === "promote") setHandedTo(outcome.next.name);
            }}>
            <UserRoundPlus className="size-5" aria-hidden="true" />{next ? t.ready.cta : outcome.kind === "clear" ? sr.clearCta : t.emptyCta}
          </Button>
        </div>
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </div>
  );
}
