"use client";
/**
 * The fallback plan: an ordered list of up to 4 recipients who receive the whole vault if no trusted person is left.
 * `FallbackPlanCard` shows and edits it (owner, estate Active); `FallbackStatus` appears once every place is empty and
 * lets anyone start and, after the long wait, carry it out.
 */
import { useId, useState, type FormEvent } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, HeartHandshake, Hourglass, Pencil, Plus, Trash2 } from "@/components/ui/icons";
import type { FallbackRecipient } from "@/lib/guardians/types";
import type { EstateSnapshot } from "@/lib/service";
import { shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Badge, Button, Card, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { FilePicker } from "@/components/ui/client";
import { ReportCard, Reviewing } from "@/components/agent/report-card";
import type { AgentReport } from "@/lib/types";
import { usePay } from "@/components/pay/payment";
import { NamesNotice } from "@/components/continuity/names-notice";
import { checkFallback, clock, isMonitor, mayRaise, objectionFor, objectionOver, fallbackStage, fallbackWinner, MAX_FALLBACK, moveItem, secondsLeft, shortName, waitFraction, type DraftRecipient } from "./derive";
import { canReportRecipient, isFamily, payoutHeldUntil } from "@/lib/guardians/decisions";
import { RecipientReports } from "./recipient";
import { RaiseObjection } from "./objections";
import { ActionResult, CountdownRing, PausedNotice, useAction, useGuardians, useWaitText } from "./parts";

const KINDS: FallbackRecipient["kind"][] = ["family", "heir", "charity"];

export function FallbackPlanCard({ snap, className }: { snap: EstateSnapshot; className?: string }) {
  const { guardians: c } = useCopy();
  const { role, session } = useEstate();
  const g = useGuardians();
  const waitText = useWaitText();
  const { act, busy, receipt, refusal } = useAction();
  const now = useNow(5000);
  const [editing, setEditing] = useState(false);
  if (!g || !g.enabled) return null;
  // While the plan runs, its status card has the reports.
  const reportsHere = fallbackStage(g, now) === "notNeeded";
  const f = c.fallback;
  const e = snap.estate;
  const ownerActive = role === "owner" && session?.address === e.owner && e.status === "Active";
  const list = g.fallback.recipients;

  const save = async (next: DraftRecipient[]) => {
    const res = await act("fallback", (s, est) => s.setFallback(est, next), f.saved);
    if (res.ok) setEditing(false);
  };

  return (
    <Card id="fallback" className={clsx("scroll-mt-24", className)}>
      <h2 className="flex items-center gap-2 text-h3"><HeartHandshake className="size-5" aria-hidden="true" />{f.title}</h2>
      <p className="mt-1 text-ink-2">{f.body}</p>
      <p className="mt-2 text-small">{fmt(f.when, { wait: waitText(g.fallbackWaitSecs) })}</p>
      {editing ? (
        <FallbackEditor snap={snap} initial={list.map(({ wallet, name, kind }) => ({ wallet, name, kind }))} busy={busy === "fallback"} onSave={(l) => void save(l)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <p className="mt-2 text-small text-ink-2">{f.order}</p>
          {list.length === 0 ? <p className="mt-3">{f.empty}</p> : (
            <ol className="mt-3 flex flex-col gap-2">
              {list.map((r, i) => (
                <li key={`${r.wallet}-${r.name}`} className="flex min-w-0 items-center gap-3 rounded-md border border-line bg-surface-2/50 p-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-small font-bold text-bg" aria-hidden="true">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className={clsx("truncate font-semibold", r.dead && "line-through")}>{r.name}</p>
                    <p className="font-mono text-[0.7rem] text-ink-2">{shortAddress(r.wallet)}</p>
                  </div>
                  <span className="sr-only">{fmt(f.position, { n: i + 1 })}</span>
                  {r.dead ? <Badge tone="danger">{f.dead}</Badge> : r.report ? <Badge tone="warn">{f.reported}</Badge> : <Badge>{f.kindShort[r.kind]}</Badge>}
                </li>
              ))}
            </ol>
          )}
          {ownerActive ? (
            <Button variant="secondary" small className="mt-3" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden="true" />{f.edit}</Button>
          ) : role === "owner" ? <p className="mt-3 text-small text-ink-2">{f.ownerOnly}</p> : null}
        </>
      )}
      {!editing && reportsHere && (
        <>
          <RecipientReports snap={snap} className="mt-3" />
          <ReportRecipientDeath />
        </>
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </Card>
  );
}

function FallbackEditor({ snap, initial, busy, onSave, onCancel }: { snap: EstateSnapshot; initial: DraftRecipient[]; busy: boolean; onSave: (l: DraftRecipient[]) => void; onCancel: () => void }) {
  const { common, guardians: c } = useCopy();
  const f = c.fallback;
  const id = useId();
  const [rows, setRows] = useState<DraftRecipient[]>(initial.length ? initial : [{ name: "", wallet: "", kind: "family" }]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const used = new Set(rows.map((r) => r.wallet));
  const picks = snap.beneficiaries.filter((b) => b.active && !used.has(b.wallet));

  const set = (i: number, patch: Partial<DraftRecipient>) => { setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x))); setError(null); };
  const move = (i: number, to: number) => {
    setRows((r) => moveItem(r, i, to));
    setAnnounce(fmt(f.position, { n: to + 1 }) + ": " + (rows[i].name || ""));
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const list = rows.map((r) => ({ ...r, name: r.name.trim(), wallet: r.wallet.trim() }));
    const problem = checkFallback(list);
    if (problem) { setError(fmt(f.errors[problem.error], { row: problem.row + 1 })); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    onSave(list);
  };

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
      <NamesNotice />
      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => {
          const label = r.name.trim() || fmt(f.position, { n: i + 1 });
          return (
            <li key={i}>
              <fieldset className="flex flex-col gap-2 rounded-md border border-line bg-surface-2/50 p-3">
                <legend className="px-1 text-small font-semibold">{fmt(f.position, { n: i + 1 })}</legend>
                <Field label={f.kind} htmlFor={`${id}-kind-${i}`}>
                  <select id={`${id}-kind-${i}`} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as FallbackRecipient["kind"] })} className={inputClass}>
                    {KINDS.map((k) => <option key={k} value={k}>{f.kinds[k]}</option>)}
                  </select>
                </Field>
                <Field label={c.name} htmlFor={`${id}-name-${i}`}>
                  <input id={`${id}-name-${i}`} value={r.name} maxLength={64} onChange={(e) => set(i, { name: e.target.value })} className={inputClass} autoComplete="off" />
                </Field>
                <Field label={c.wallet} htmlFor={`${id}-wallet-${i}`} hint={i === 0 ? c.walletHint : undefined}>
                  <input id={`${id}-wallet-${i}`} value={r.wallet} onChange={(e) => set(i, { wallet: e.target.value })} className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} />
                </Field>
                <div className="flex flex-wrap gap-1">
                  <Button variant="quiet" small disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={fmt(c.moveUp, { name: label })}><ArrowUp className="size-4" aria-hidden="true" /></Button>
                  <Button variant="quiet" small disabled={i === rows.length - 1} onClick={() => move(i, i + 1)} aria-label={fmt(c.moveDown, { name: label })}><ArrowDown className="size-4" aria-hidden="true" /></Button>
                  <Button variant="ghost" small onClick={() => setRows((x) => x.filter((_, n) => n !== i))}><Trash2 className="size-4" aria-hidden="true" />{fmt(c.remove, { name: label })}</Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {rows.length < MAX_FALLBACK ? (
        <Button variant="secondary" small className="self-start" onClick={() => setRows((x) => [...x, { name: "", wallet: "", kind: "charity" }])}><Plus className="size-4" aria-hidden="true" />{f.add}</Button>
      ) : <p className="text-small text-ink-2">{f.max}</p>}
      {picks.length > 0 && rows.length < MAX_FALLBACK && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-ink-2">{c.suggestions}</span>
          {picks.map((b) => (
            <button key={b.wallet} type="button" className="min-h-11 rounded-full border border-line-strong bg-surface px-3.5 text-small font-medium hover:bg-surface-2"
              onClick={() => { setError(null); setRows((x) => {
                const p = { name: b.label, wallet: b.wallet, kind: "family" as const };
                const empty = x.findIndex((r) => !r.name.trim() && !r.wallet.trim());
                return empty >= 0 ? x.map((r, n) => (n === empty ? p : r)) : [...x, p];
              }); }}>
              {b.label}
            </button>
          ))}
        </div>
      )}
      <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
      {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onCancel}>{c.cancel}</Button>
        <Button type="submit" className="flex-1" loading={busy}>{c.save}</Button>
      </div>
    </form>
  );
}

/** Shown when every trusted place is empty (or the fallback has started / finished). Anyone may start and carry it out. */
export function FallbackStatus({ snap, className }: { snap: EstateSnapshot; className?: string }) {
  const { guardians: c } = useCopy();
  const { session } = useEstate();
  const g = useGuardians();
  const now = useNow();
  const waitText = useWaitText();
  const { act, busy, receipt, refusal } = useAction();
  const { pay } = usePay();
  const stage = fallbackStage(g, now);
  if (!g || !g.enabled || stage === "notNeeded") return null;
  const s = c.fallbackStatus;
  const winner = fallbackWinner(g.fallback);
  const name = winner?.recipient.name ?? "";
  const left = secondsLeft(g.fallback.readyAt, now);
  const guardTarget = g.address ?? g.objections.find((o) => o.kind === "Fallback")?.target;
  // Any watcher or family member may object to the fallback while it counts down.
  const me = session?.address;
  const mayObject = !!guardTarget && (isMonitor(g, me) || isFamily(snap, me)) && mayRaise(snap, "Fallback", guardTarget, me, now);
  const heldUntil = payoutHeldUntil(snap, now);
  const objection = guardTarget ? objectionFor(g, guardTarget) : null;
  const paused = objection?.status === "Open" && !objectionOver(objection, now);

  const execute = async () => {
    if (!winner) return;
    await pay({
      kind: "program", source: "vault", to: winner.recipient.wallet, toLabel: winner.recipient.name, amount: snap.estate.vaultBalance,
      execute: (svc, est) => svc.executeFallback(est),
      successText: fmt(s.executable.done, { name }),
    });
  };

  return (
    <Card aria-label={s.title} className={clsx("border-2 border-ink", className)}>
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-bg"><HeartHandshake className="size-5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          {stage === "waitingOwner" && <><h2 className="text-h3">{s.waitingOwner.title}</h2><p className="mt-1 text-ink-2">{s.waitingOwner.body}</p></>}
          {stage === "ready" && (
            <>
              <h2 className="text-h3">{s.ready.title}</h2>
              <p className="mt-1 text-ink-2">{fmt(s.ready.body, { wait: waitText(g.fallbackWaitSecs * (snap.estate.status === "Active" && snap.estate.death.verdict === "Referred" ? 2 : 1)) })}</p>
              <Button className="mt-3" loading={busy === "fallback-start"} disabled={!!busy} onClick={() => void act("fallback-start", (svc, est) => svc.startFallback(est), s.ready.done)}>{s.ready.cta}</Button>
            </>
          )}
          {stage === "counting" && (
            <>
              <div className="flex items-center gap-3">
                <CountdownRing fraction={waitFraction(g.fallback.readyAt, (g.fallback.readyAt ?? 0) - (g.fallback.startedAt ?? 0), now)} />
                <h2 className="text-h3 tabular-nums" role="timer" aria-live="off">{left === null ? s.title : fmt(s.counting.title, { time: clock(left) })}</h2>
              </div>
              <p className="mt-2 text-ink-2">{winner ? fmt(s.counting.body, { name }) : s.noOne}</p>
              {guardTarget && <PausedNotice target={guardTarget} className="mt-2" />}
              {mayObject && guardTarget && <div className="mt-3"><RaiseObjection kind="Fallback" target={guardTarget} seatIndex={null} /></div>}
            </>
          )}
          {stage === "executable" && (
            <>
              <h2 className="flex items-center gap-2 text-h3"><Hourglass className="size-5" aria-hidden="true" />{s.executable.title}</h2>
              <p className="mt-1 text-ink-2">{winner ? fmt(s.executable.body, { name }) : s.noOne}</p>
              {guardTarget && <PausedNotice target={guardTarget} className="mt-2" />}
              {winner && heldUntil !== null && now !== null && (
                <p role="status" className="mt-2 text-small font-semibold tabular-nums">{fmt(c.rules.recipient.held, { name: shortName(name), time: clock(heldUntil - now) })}</p>
              )}
              {winner && heldUntil === null && !paused && <Button className="mt-3" disabled={!!busy} onClick={() => void execute()}>{s.executable.cta}</Button>}
            </>
          )}
          {stage === "done" && (
            <Notice tone="ok" title={s.done.title}><p>{fmt(s.done.body, { name })}</p></Notice>
          )}
        </div>
      </div>
      {stage !== "done" && (
        <>
          <RecipientReports snap={snap} className="mt-3" />
          <ReportRecipientDeath />
        </>
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </Card>
  );
}

/** A participant reports that a recipient has died; the agent's verdict only opens it to a second person (R4). */
function ReportRecipientDeath() {
  const { common, guardians: c } = useCopy();
  const r = c.fallbackStatus.reportDeath;
  const g = useGuardians();
  const { snap, session } = useEstate();
  const now = useNow(5000);
  const id = useId();
  const { act, busy, receipt, refusal } = useAction();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<number | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [reported, setReported] = useState("");
  const options = (g?.fallback.recipients ?? []).map((x, i) => ({ ...x, i })).filter((x) => x.kind !== "charity" && !!snap && canReportRecipient(snap, x.i, session?.address, now));
  if (busy === "fallback-death") return <div className="mt-4"><Reviewing /></div>;
  if (report) {
    return (
      <div className="mt-4">
        <ReportCard report={report} compact />
        {report.verdict === "approve"
          ? <p role="status" className="mt-2 text-small font-semibold">{fmt(r.done, { name: shortName(reported) })}</p>
          : <p role="alert" className="mt-2 text-small font-semibold">{r.rejected}</p>}
        <ActionResult receipt={receipt} refusal={null} />
        <Button variant="quiet" small className="mt-2" onClick={() => { setReport(null); setFile(null); setIndex(""); setOpen(false); }}>{c.cancel}</Button>
      </div>
    );
  }
  if (options.length === 0) return null;
  if (!open) return <Button variant="quiet" small className="mt-4" onClick={() => setOpen(true)}>{r.open}</Button>;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (index === "") { setError(c.report.needPerson); return; }
    if (!file) { setError(c.report.needFile); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const name = g?.fallback.recipients[index]?.name ?? "";
    const res = await act("fallback-death", (s, est) => s.reportFallbackDeath(est, index, file));
    if (res.ok) { setReported(name); setReport(res.value.report); }
  };

  return (
    <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-3 rounded-md border border-line bg-surface-2/50 p-3">
      <div>
        <p className="font-semibold">{r.title}</p>
        <p className="text-small text-ink-2">{r.body}</p>
      </div>
      <Field label={r.person} htmlFor={`${id}-who`}>
        <select id={`${id}-who`} value={index} onChange={(e) => { setIndex(e.target.value === "" ? "" : Number(e.target.value)); setError(null); }} className={inputClass}>
          <option value="">{c.report.choose}</option>
          {options.map((o) => <option key={o.wallet} value={o.i}>{o.name}</option>)}
        </select>
      </Field>
      <FilePicker id={`${id}-cert`} label={c.report.file} hint={c.report.fileHint} file={file} onFile={(f) => { setFile(f); setError(null); }} samples={c.report.samples} copy={common.file} />
      <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
      {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>{c.cancel}</Button>
        <Button type="submit" className="flex-1">{r.submit}</Button>
      </div>
      <ActionResult receipt={null} refusal={refusal} />
    </form>
  );
}
