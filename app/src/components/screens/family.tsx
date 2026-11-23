"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { m as motion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import { ArrowRight, Check, FileHeart, HeartPulse, LockOpen, TriangleAlert } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot, TxResult } from "@/lib/service";
import type { AgentReport, Role } from "@/lib/types";
import { formatUsdt, shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, ButtonLink, Card, Consent, ExplorerLink, Notice, PageHeader } from "@/components/ui/primitives";
import { FilePicker } from "@/components/ui/client";
import { ReportCard, Reviewing } from "@/components/agent/report-card";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate, HeaderFrame } from "@/components/shell/gate";
import { LegacyEntry, MilestoneMoment } from "@/components/legacy/lazy";
import { LetterMoment } from "@/components/letters/lazy";
import { PausedNotice } from "@/components/guardians/parts";
import { guardiansOf, isMonitor, mayRaise } from "@/components/guardians/derive";
import { ReplaceWhen, useWho, VoteTally } from "@/components/guardians/decision";
import { canSubmitDeath, deathDisproved, deathOpen, deathReplace, deathTally, hasLivingSeat, reporterKind } from "@/lib/guardians/decisions";
import { MIN_WAIT_SECS, unlockWaitSecs } from "@/lib/death-rules";
import { RaiseObjection } from "@/components/guardians/objections";
import { SuccessionTimeline } from "@/components/guardians/section";
import { DisputePanel } from "@/components/disputes/disputes";

type Copy = ScreensCopy["family"];
type StepState = "done" | "now" | "next";

export function clock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Animated with motion, so it brings its own <MotionScope> (the first pages never load the library). */
export function FamilyScreen(props: Parameters<typeof FamilyScreenBody>[0]) {
  return <MotionScope><FamilyScreenBody {...props} /></MotionScope>;
}

function FamilyScreenBody({ copy: english }: { copy: Copy }) {
  const copy = useLocalized(english, (t) => t.screens.family);
  return <Gate frame={<HeaderFrame width="max-w-2xl" eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />}>{({ snap, role }) => <Timeline copy={copy} snap={snap!} role={role} />}</Gate>;
}

function Timeline({ copy, snap, role }: { copy: Copy; snap: EstateSnapshot; role: Role }) {
  const { common, guardians } = useCopy();
  const { run, busy, session, intent, setIntent } = useEstate();
  const now = useNow();
  const who = useWho(snap);
  const rules = guardians.rules;
  // Kept here, not in the form: once the report is in, the estate leaves "Active" and the form is no longer shown.
  const [accepted, setAccepted] = useState<{ report: AgentReport; tx: TxResult } | null>(null);
  const e = snap.estate;
  const d = e.death;
  const tally = deathTally(e);
  const report = (d as { agentReport?: AgentReport }).agentReport;
  const reported = !!d.certHash || e.status === "DeathPending" || e.status === "Unlocked";
  const confirmed = e.status === "DeathPending" || e.status === "Unlocked";
  const unlocked = e.status === "Unlocked";
  // Decided alone (the only trusted person left reported it and confirmed it): the unlock waits twice as long.
  const wait = unlockWaitSecs(e);
  const disproved = deathDisproved(e);
  const remaining = e.status === "DeathPending" && d.pendingSince !== null && now !== null ? d.pendingSince + wait - now : null;
  const waitOver = remaining !== null && remaining <= 0;
  // The plan's own pause; when it was decided alone the sentence below says it is twice that, and the countdown counts it.
  const base = Math.max(e.waitingPeriodSecs, MIN_WAIT_SECS);
  const period = base >= 86400 ? fmt(copy.periodDays, { days: Math.round(base / 86400) }) : fmt(copy.periodDemo, { secs: base });
  const family = reporterKind(snap, session?.address) === "family";
  const reports = reporterKind(snap, session?.address) !== null;
  const reporter = d.submittedBy ? snap.beneficiaries.find((b) => b.wallet === d.submittedBy)?.label ?? who(d.submittedBy) : "";
  // A disproved claim (the owner showed life after it) can be replaced at once, also while DeathPending.
  const open = (e.status === "Active" && !!d.certHash) || disproved;
  const replaceable = open && !disproved ? deathReplace(e) : null;
  const canReplace = open && canSubmitDeath(snap, session?.address, now);
  const s = copy.steps;
  const reportRef = useRef<HTMLDivElement>(null);

  // The agent can send the user straight to the upload.
  useEffect(() => {
    if (intent?.kind === "upload" && intent.purpose === "death") {
      reportRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      setIntent(null);
    }
  }, [intent, setIntent]);

  const state = (done: boolean, current: boolean): StepState => (done ? "done" : current ? "now" : "next");
  const steps: { key: string; title: string; text: string; state: StepState; extra?: ReactNode }[] = [
    { key: "signed", title: s.signed.title, state: "done", text: fmt(s.signed.done, { name: e.ownerName, amount: formatUsdt(e.vaultBalance, { decimals: 0 }) }) },
    {
      key: "reported", title: s.reported.title, state: state(reported, !reported),
      text: !reported ? s.reported.todo
        : fmt(open && d.verdict === "Pending" ? rules.death.pending : open && d.verdict === "Referred" ? rules.death.referred : s.reported.done, { name: reporter || e.ownerName }),
      extra: reported && d.certHash ? (
        <>
          {disproved && <p className="mt-2 text-small font-semibold">{rules.errors.DeathDisproved}</p>}
          {open && !disproved && (replaceable
            ? <ReplaceWhen times={replaceable} who="death" />
            : d.verdict !== "Pending" && !hasLivingSeat(e) && <p className="mt-2 text-small font-semibold">{rules.replace.kept}</p>)}
          <p className="mt-1 text-[0.75rem] text-ink-2">{copy.certificate}: <span className="font-mono">{shortAddress(d.certHash, 6)}</span></p>
          {report && !confirmed && <div className="mt-3"><ReportCard report={report} compact /></div>}
        </>
      ) : undefined,
    },
    {
      key: "confirmed", title: s.confirmed.title, state: state(confirmed, reported && !confirmed),
      text: confirmed
        ? d.attestations.some(Boolean) ? fmt(s.confirmed.done, { got: d.attestations.filter(Boolean).length }) : rules.death.byFallback
        : tally.eligible === 0 ? rules.tally.nobody : fmt(s.confirmed.todo, { need: tally.needed, total: tally.eligible }),
      extra: reported && !confirmed ? (
        <div className="mt-2"><VoteTally kind="confirmed" tally={tally} names={e.verifierNames} /></div>
      ) : undefined,
    },
    {
      key: "waiting", title: s.waiting.title, state: state(unlocked, e.status === "DeathPending"),
      text: unlocked ? s.waiting.done : fmt(s.waiting.todo, { period }),
      extra: e.status === "DeathPending" && !disproved ? (
        <div className="mt-3">
          {d.decidedAlone && <p className="mb-3 text-small font-semibold">{rules.death.alone}</p>}
          <div className="flex items-center gap-4">
            <CountdownRing fraction={remaining === null ? 0 : 1 - Math.max(0, remaining) / wait} />
            <div>
              <p className="font-display text-h2 tabular-nums" role="timer" aria-live="off">{remaining === null ? "" : waitOver ? s.waiting.ready : fmt(s.waiting.running, { time: clock(remaining) })}</p>
              <p className="text-small text-ink-2">{copy.unlock.hint}</p>
            </div>
          </div>
          <PausedNotice target={e.address} className="mt-3" />
          <DisputePanel kind="Unlock" target={e.address} className="mt-3" />
          {isMonitor(guardiansOf(snap), session?.address) && mayRaise(snap, "Unlock", e.address, session?.address, now) && (
            <div className="mt-3"><RaiseObjection kind="Unlock" target={e.address} seatIndex={null} /></div>
          )}
          {waitOver && (
            <Button className="mt-3" loading={busy === "unlock"} onClick={() => run("unlock", (svc, est) => svc.finalizeUnlock(est), copy.unlock.done)}>
              <LockOpen className="size-5" aria-hidden="true" />{copy.unlock.cta}
            </Button>
          )}
        </div>
      ) : undefined,
    },
    {
      key: "unlocked", title: s.unlocked.title, state: state(unlocked, false), text: unlocked ? s.unlocked.done : s.unlocked.todo,
      extra: unlocked ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {role === "beneficiary" && family && <ButtonLink href="/claims" small>{copy.next.claims}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>}
          {role === "verifier" && <ButtonLink href="/inbox" small>{copy.next.inbox}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>}
          <ButtonLink href="/car" small variant="secondary">{copy.next.car}</ButtonLink>
        </div>
      ) : undefined,
    },
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      <div className="mb-5 grid gap-3 empty:hidden"><LetterMoment /><MilestoneMoment /><LegacyEntry /></div>

      {role === "owner" && session?.address === e.owner && deathOpen(e) && (
        <Notice tone="danger" icon={<TriangleAlert className="size-6" aria-hidden="true" />} title={copy.veto.title} className="mb-5">
          <p className="text-body">{copy.veto.body}</p>
          <p className="mt-1 text-body font-semibold">{rules.here.warning}</p>
          <Button className="mt-3" loading={busy === "veto"} onClick={() => run("veto", (svc, est) => svc.vetoDeath(est), copy.veto.done)}>
            <HeartPulse className="size-5" aria-hidden="true" />{copy.veto.cta}
          </Button>
        </Notice>
      )}

      <ol className="relative">
        {steps.map((st, i) => (
          <li key={st.key} className="relative flex gap-4 pb-6 last:pb-0" aria-current={st.state === "now" ? "step" : undefined}>
            {i < steps.length - 1 && (
              <span className="absolute left-[1.0625rem] top-9 h-[calc(100%-2.25rem)] w-0.5 overflow-hidden rounded bg-line" aria-hidden="true">
                <motion.span className="block w-full bg-accent" initial={false} animate={{ height: st.state === "done" ? "100%" : "0%" }} transition={{ duration: 0.6 }} />
              </span>
            )}
            <motion.span
              initial={false} animate={{ scale: st.state === "now" ? [1, 1.12, 1] : 1 }} transition={{ duration: 0.5 }}
              className={clsx(
                "relative z-10 grid size-9 shrink-0 place-items-center rounded-full border-2 text-small font-bold",
                st.state === "done" ? "border-ink bg-ink text-bg" : st.state === "now" ? "border-dashed border-ink bg-surface text-ink" : "border-line bg-surface text-ink-2",
              )}
              aria-hidden="true"
            >
              {st.state === "done" ? <Check className="size-5" /> : i + 1}
            </motion.span>
            <div className={clsx("min-w-0 flex-1 rounded-lg border p-3.5", st.state === "now" ? "border-[1.5px] border-dashed border-ink bg-surface" : "border-line bg-surface")}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-sans text-body font-semibold tracking-normal">{st.title}</h2>
                <span className={clsx("text-[0.75rem] font-semibold uppercase tracking-wider", st.state === "done" ? "text-ok" : st.state === "now" ? "text-amber-ink" : "text-ink-2")}>
                  {st.state === "done" ? copy.stateDone : st.state === "now" ? copy.stateNow : copy.stateNext}
                </span>
              </div>
              <p className="mt-1 text-small text-ink-2">{st.text}</p>
              {st.extra}
            </div>
          </li>
        ))}
      </ol>

      {accepted && d.certHash ? (
        <div className="mt-6"><ReportAccepted copy={copy} report={accepted.report} tx={accepted.tx} /></div>
      ) : ((e.status === "Active" && !d.certHash) || canReplace) && (
        <div ref={reportRef} className="mt-6 scroll-mt-32">
          {/* Family, trusted people and living listed fallback recipients may report it; never the agent or a stranger. */}
          {canReplace || reports
            ? <ReportForm key={d.certHash ?? "first"} copy={copy} replacing={open} onAccepted={setAccepted} />
            : role !== "owner" && session?.address !== e.agent ? <p className="text-small text-ink-2">{rules.death.whoMay}</p> : null}
        </div>
      )}
      <SuccessionTimeline snap={snap} />
      <p className="sr-only" role="status" aria-live="polite">{common.status.estate[e.status]}</p>
    </div>
  );
}

function CountdownRing({ fraction }: { fraction: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="size-16 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ink)" strokeWidth="6" strokeLinecap="butt" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, fraction)))} style={{ transition: "stroke-dashoffset 1s linear" }} />
    </svg>
  );
}

/** The report went in: what the agent found, and the receipt. */
function ReportAccepted({ copy, report, tx }: { copy: Copy; report: AgentReport; tx: TxResult }) {
  const r = copy.report;
  return (
    <Card>
      <Notice tone="ok" icon={<Check className="size-5" aria-hidden="true" />} title={r.acceptedTitle}><p role="status">{r.acceptedBody}</p></Notice>
      <div className="mt-3"><ReportCard report={report} /></div>
      {tx.signature && <ExplorerLink className="mt-3" signature={tx.signature} label={r.receipt} srLabel={r.receiptSr} />}
    </Card>
  );
}

function ReportForm({ copy, replacing, onAccepted }: { copy: Copy; replacing: boolean; onAccepted: (r: { report: AgentReport; tx: TxResult }) => void }) {
  const { common, guardians } = useCopy();
  const { run, busy } = useEstate();
  const r = copy.report;
  const again = guardians.rules.replace;
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<AgentReport | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!file) { setError(r.needFile); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await run("death", (s, est) => s.submitDeathClaim(est, file));
    if (res.ok && res.value.report.verdict === "reject") setRejected(res.value.report);
    else if (res.ok) onAccepted({ report: res.value.report, tx: res.value.tx });
  };

  if (busy === "death") return <Reviewing />;
  if (rejected) {
    return (
      <Card>
        <Notice tone="danger" icon={<TriangleAlert className="size-5" aria-hidden="true" />} title={r.rejectedTitle}><p role="alert">{r.rejectedBody}</p></Notice>
        <div className="mt-3"><ReportCard report={rejected} /></div>
        <Button variant="secondary" className="mt-3" onClick={() => { setRejected(null); setFile(null); }}>{r.again}</Button>
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-h3"><FileHeart className="size-5 text-amber" aria-hidden="true" />{replacing ? again.deathTitle : r.title}</h2>
      <p className="mt-1 text-ink-2">{replacing ? again.deathBody : r.body}</p>
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
        <FilePicker id="death-cert" label={r.file} hint={r.fileHint} file={file} onFile={(f) => { setFile(f); setError(null); }} samples={r.samples} copy={common.file} />
        <Consent id="death-consent" checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
        {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
        <Button type="submit">{r.submit}</Button>
      </form>
    </Card>
  );
}
