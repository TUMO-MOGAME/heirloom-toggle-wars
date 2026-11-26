"use client";
/**
 * The guided run (plan §22.2): one page walks a newcomer through the whole story with no switching people. The steps
 * (lib/guided/run.ts) use the app's own flows; this screen collects the two inputs (a name and PIN on devnet, the
 * plan's numbers), runs the rest one after another with a pause the reader can follow, and shows each step's
 * transactions. The demo runs the same steps on the simulated service.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { guided as english } from "@/content/guided";
import { continuity } from "@/content/continuity";
import { useLocale, useLocalized } from "@/lib/i18n/client";
import { useEstate } from "@/lib/hooks/estate";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { isMockService } from "@/lib/service/is-mock";
import { chainConfig } from "@/lib/chain/config";
import { shortAddress } from "@/lib/format";
import { starterRefusalText } from "@/lib/starter/refusal";
import {
  GUIDED_STEPS, WAITS_FOR_TAP, checkPlan, clockText, elapsedMs, initialState, interrupted, isFinished, nextStep, overCapAmount,
  parseState, progress, setPlan, stepMs, stepOf, storeKey,
  type GuidedState, type GuidedStepId, type PlanProblem, type SamplePlan, type StepError, type StepRecord,
} from "@/lib/guided/machine";
import { SAMPLE_DOCUMENT, SAMPLE_TRUSTED, SAMPLE_UNTIL, runNext, type GuidedDeps } from "@/lib/guided/run";
import type { Base58 } from "@/lib/types";
import { Badge, Button, ButtonLink, Card, Consent, Eyebrow, ExplorerLink, Field, inputClass, Notice, TickDisc } from "@/components/ui/primitives";
import { Marked } from "@/components/ui/marked";
import { CircleDashed, CircleX, Loader2, Pause, Play, RotateCcw, TriangleAlert } from "@/components/ui/icons";
import { fmt, useCopy } from "@/components/shell/copy";
import { usePin } from "@/components/shell/pin-gate";

type Copy = typeof english;
/** The pause between steps that run by themselves, so the reader can follow each one. */
const STEP_PAUSE_MS = 1200;
const MODE: GuidedState["mode"] = chainConfig.dataMode === "chain" ? "chain" : "mock";

function load(): GuidedState | null {
  try { return parseState(window.localStorage.getItem(storeKey(MODE)), MODE); } catch { return null; }
}
function save(s: GuidedState | null) {
  try {
    if (s) window.localStorage.setItem(storeKey(MODE), JSON.stringify(s));
    else window.localStorage.removeItem(storeKey(MODE));
  } catch { /* storage blocked: the run still works in this tab */ }
}

export function GuidedRun() {
  const copy = useLocalized(english, (t) => t.guided);
  const starterCopy = continuity[useLocale()].starter;
  const { common } = useCopy();
  const { service, explain, resetDemo } = useEstate();
  const wallet = useWallet();
  const pinGate = usePin();
  const reduced = useReducedMotion();

  const [run, setRun] = useState<GuidedState | null>(null);
  const [resumable, setResumable] = useState(false);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [now, setNow] = useState(0); // set after mount: the prerendered page holds no clock
  const [restartArmed, setRestartArmed] = useState(false);
  // Devnet wallet form. The PIN is kept in memory only until the practice wallets are made, so one PIN covers all.
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [consent, setConsent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const pinRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const runRef = useRef<GuidedState | null>(null);

  const commit = useCallback((s: GuidedState | null) => { runRef.current = s; setRun(s); save(s); }, []);

  // A run saved on this device is offered to pick up again; a step that was running when the page closed is shown as
  // interrupted (each step checks what already went through, so trying it again never repeats it).
  useEffect(() => {
    const saved = load();
    const s = saved ? interrupted(saved, Date.now()) : initialState(MODE);
    /* eslint-disable react-hooks/set-state-in-effect -- read after mount, so the server markup matches */
    commit(s);
    setNow(Date.now());
    setResumable(!!saved && saved.startedAt !== null && !isFinished(saved));
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => { pinRef.current = null; };
  }, [commit]);

  const ticking = !!run && run.startedAt !== null && run.finishedAt === null;
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  const stepTitle = useCallback((id: GuidedStepId) => copy.steps[id].title, [copy]);

  const deps = useCallback((): GuidedDeps | null => {
    if (!service) return null;
    const ownerLabel = (owner?: Base58) => wallet.sessions.find((x) => x.address === owner)?.label;
    if (isMockService(service)) {
      const people = wallet.sessions;
      const actorOf = (address: Base58) => {
        const p = people.find((x) => x.address === address);
        return { address, role: p?.role ?? "beneficiary", label: p?.label ?? address };
      };
      return {
        service, now: Date.now, words: copy.draft,
        ownerName: (ownerLabel(runRef.current?.owner) ?? "Thabo Mokoena").replace(/\s*\(.*\)$/, ""),
        async createOwner() {
          const owner = people.find((x) => x.role === "owner");
          if (!owner) throw new Error("The demo family is not loaded yet.");
          await resetDemo("fresh");
          wallet.switchTo(owner.address);
          service.setActor(actorOf(owner.address));
          return owner.address;
        },
        async createFamily() {
          const child = people.find((x) => x.role === "beneficiary" && /^Lerato\b/.test(x.label));
          const trusted = people.filter((x) => x.role === "verifier").slice(0, 3);
          if (!child || trusted.length !== 3) throw new Error("The demo family is not loaded yet.");
          return [child.address, ...trusted.map((x) => x.address)];
        },
        as: (address, work) => service.withActor(actorOf(address), work),
        evidence: sampleDocument,
        balanceOf: async (a) => service.balanceOf(a),
      };
    }
    return {
      service, now: Date.now, words: copy.draft,
      ownerName: (ownerLabel(runRef.current?.owner) ?? name).trim(),
      async createOwner() {
        pinGate.preset(pinRef.current);
        try { return (await wallet.create(name.trim(), "owner")).session.address; } finally { pinGate.preset(null); }
      },
      async createFamily(list) {
        pinGate.preset(pinRef.current);
        try { return await wallet.createPractice(list); } finally { pinGate.preset(null); pinRef.current = null; }
      },
      as: (address, work) => wallet.actAs(address, work),
      evidence: sampleDocument,
      async balanceOf(a) {
        const { readBalances } = await import("@/lib/chain/balances");
        return (await readBalances([a]).catch(() => null))?.get(a)?.usdt ?? null;
      },
    };
  }, [service, wallet, copy.draft, name, pinGate, resetDemo]);

  /** Runs the next step; the screen shows it running, then done or stopped with the reason. */
  const go = useCallback(async () => {
    const s = runRef.current;
    const d = deps();
    const id = s ? nextStep(s) : null;
    if (!s || !d || !id || runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setResumable(false);
    const total = GUIDED_STEPS.length;
    setAnnounce(fmt(copy.announce.started, { n: GUIDED_STEPS.indexOf(id) + 1, total, step: stepTitle(id) }));
    try {
      const out = await runNext(s, d, (r) => commit(r));
      commit(out);
      const rec = stepOf(out, id);
      setNow(Date.now());
      if (rec.status === "failed") setAnnounce(fmt(copy.announce.failed, { step: stepTitle(id) }));
      else if (isFinished(out)) setAnnounce(fmt(copy.announce.finished, { total, time: clockText(elapsedMs(out, Date.now())) }));
      else setAnnounce(fmt(copy.announce.done, { step: stepTitle(id) }));
      if (id === "money" || id === "fund" || id === "pay") void wallet.refreshBalances().catch(() => undefined);
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  }, [deps, commit, copy.announce, stepTitle, wallet]);

  // Steps that need no input run by themselves, one after another, with a pause the reader can follow. A stopped
  // step waits for "Try again"; a paused run waits for "Continue".
  const next = run ? nextStep(run) : null;
  const nextRec = run && next ? stepOf(run, next) : null;
  const canAuto = !!run && !!next && auto && !busy && !resumable && run.startedAt !== null && nextRec?.status === "todo" && !WAITS_FOR_TAP.includes(next);
  useEffect(() => {
    if (!canAuto) return;
    const id = window.setTimeout(() => void go(), STEP_PAUSE_MS);
    return () => window.clearTimeout(id);
  }, [canAuto, go, next]);

  // Keep the step being worked on in view, and put focus on a step that asks for something.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!next || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-step="${next}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    if (next === "plan" && run?.startedAt !== null) el?.querySelector<HTMLElement>("[data-focus]")?.focus({ preventScroll: true });
  }, [next, reduced, run?.startedAt]);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const finished = !!run && isFinished(run);
  useEffect(() => { if (finished) doneRef.current?.focus({ preventScroll: false }); }, [finished]);

  const startWallet = (e?: FormEvent) => {
    e?.preventDefault();
    if (MODE === "chain") {
      if (!name.trim()) { setFormError(copy.wallet.nameError); return; }
      if (!/^\d{6,}$/.test(pin)) { setFormError(copy.wallet.pinError); return; }
      if (pin !== pin2) { setFormError(copy.wallet.pinMismatch); return; }
      if (!consent) { setFormError(common.consentRequired); return; }
      pinRef.current = pin;
      setPin(""); setPin2("");
    }
    setFormError(null);
    void go();
  };

  const restart = (now = false) => {
    if (!now && !restartArmed) { setRestartArmed(true); window.setTimeout(() => setRestartArmed(false), 4000); return; }
    setRestartArmed(false);
    pinRef.current = null;
    setResumable(false);
    setAuto(true);
    commit(initialState(MODE));
  };

  const errorText = (err: StepError): string => {
    if (err.code === "starter") return starterRefusalText(starterCopy, { code: err.starterCode, retryAfterSecs: err.retryAfterSecs }, Date.now()).text;
    if (err.code === "plan") {
      const p = (Object.keys(copy.plan.problems) as PlanProblem[]).find((k) => err.message.includes(k));
      return p ? copy.plan.problems[p] : copy.errors.plan;
    }
    if (err.code in copy.errors && err.code !== "details") return copy.errors[err.code as keyof Copy["errors"]];
    const said = explain(Object.assign(new Error(err.message), { code: err.code }));
    return said.code === "generic" ? `${copy.errors.generic} ${said.message}` : said.message;
  };

  if (!run) return <div className="mx-auto w-full max-w-2xl" aria-busy="true" />;

  const { done, total } = progress(run);
  const elapsed = elapsedMs(run, now);
  const started = run.startedAt !== null;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Eyebrow>{copy.page.eyebrow}</Eyebrow>
      <h1 className="mt-2 text-h1"><Marked text={copy.page.title} /></h1>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-ink-2">
        <Badge tone={MODE === "chain" ? "accent" : "warn"}>{MODE === "chain" ? copy.page.badgeChain : copy.page.badgeMock}</Badge>
        <span>{MODE === "chain" ? copy.page.bodyChain : copy.page.bodyMock}</span>
      </p>

      <Card className="sticky top-[calc(var(--header-h,0px)+0.5rem)] z-10 mt-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-small">
          <span className="font-semibold">{fmt(copy.progress.count, { done, total })}</span>
          <span className="tabular-nums text-ink-2">{copy.progress.elapsed} <span className="font-semibold text-ink">{clockText(elapsed)}</span></span>
        </div>
        <div
          role="progressbar" aria-label={copy.progress.label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
          aria-valuetext={fmt(copy.progress.count, { done, total })} className="mt-2 h-2 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${(done / total) * 100}%` }} />
        </div>
      </Card>
      {started && !finished && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-2">
            <Button small variant="secondary" onClick={() => setAuto((a) => !a)} aria-pressed={!auto}>
              {auto ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
              {auto ? copy.controls.pause : copy.controls.resume}
            </Button>
            <Button small variant="ghost" onClick={() => restart()} disabled={busy}>
              <RotateCcw className="size-4" aria-hidden="true" />{restartArmed ? copy.controls.restartConfirm : copy.controls.restart}
            </Button>
          </div>
          {!auto && !busy && <p className="mt-2 text-small text-ink-2">{copy.controls.paused}</p>}
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>

      {resumable && next && (
        <Notice tone="accent" className="mt-4" title={copy.controls.resumeRun}>
          <p>{fmt(copy.controls.resumeBody, { n: GUIDED_STEPS.indexOf(next) + 1, step: stepTitle(next) })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button small onClick={() => { setResumable(false); setAuto(true); if (!WAITS_FOR_TAP.includes(next)) void go(); }}>
              <Play className="size-4" aria-hidden="true" />{copy.controls.resume}
            </Button>
            <Button small variant="secondary" onClick={() => restart(true)}>{copy.controls.restart}</Button>
          </div>
        </Notice>
      )}

      <ol ref={listRef} className="mt-5 grid gap-3">
        {run.steps.map((r, i) => (
          <StepItem
            key={r.id} r={r} n={i + 1} copy={copy} run={run} now={now} current={r.id === next} busy={busy && r.id === next}
            errorText={errorText}
            onRetry={() => { setAuto(true); void go(); }}
            panel={r.id === next && !busy && !resumable ? (
              r.id === "wallet" && (r.status === "todo" || r.status === "failed") ? (
                <WalletPanel
                  copy={copy} common={common} name={name} setName={setName} pin={pin} setPin={setPin} pin2={pin2} setPin2={setPin2}
                  consent={consent} setConsent={setConsent} error={formError} onStart={startWallet}
                />
              ) : r.id === "plan" ? (
                <PlanPanel copy={copy} plan={run.plan} onUse={(plan) => { commit(setPlan(run, plan)); setAuto(true); void Promise.resolve().then(go); }} />
              ) : null
            ) : null}
          />
        ))}
      </ol>

      {finished && (
        <Card className="mt-5">
          <h2 ref={doneRef} tabIndex={-1} className="flex items-center gap-2 text-h2 outline-none"><TickDisc tone="ok" className="size-6" />{copy.done.title}</h2>
          <p className="mt-2 text-ink-2">{fmt(MODE === "chain" ? copy.done.body : copy.done.bodyMock, { steps: total, time: clockText(elapsed) })}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <ButtonLink href="/vault" block>{copy.done.vault}</ButtonLink>
            <ButtonLink href="/claims" variant="secondary" block>{copy.done.claims}</ButtonLink>
            <Button variant="secondary" block onClick={() => restart(true)}><RotateCcw className="size-4" aria-hidden="true" />{copy.done.again}</Button>
          </div>
        </Card>
      )}

      <div className="mt-6">
        <ButtonLink href="/start" variant="ghost" small>{copy.page.back}</ButtonLink>
      </div>
    </div>
  );
}

async function sampleDocument(): Promise<File> {
  const res = await fetch(SAMPLE_DOCUMENT);
  if (!res.ok) throw new Error(`The demo document could not be loaded (${res.status}).`);
  return new File([await res.blob()], SAMPLE_DOCUMENT.split("/").pop()!, { type: "application/pdf" });
}

/* ---------- one step ---------- */

function StepItem({ r, n, copy, run, now, current, busy, panel, errorText, onRetry }: {
  r: StepRecord; n: number; copy: Copy; run: GuidedState; now: number; current: boolean; busy: boolean;
  panel: ReactNode; errorText: (e: StepError) => string; onRetry: () => void;
}) {
  const t = copy.steps[r.id];
  const status = busy ? "running" : r.status;
  const time = r.startedAt !== undefined ? clockText(stepMs(r, now)) : "";
  return (
    <li
      data-step={r.id} aria-current={current ? "step" : undefined}
      className={clsx("rounded-lg border bg-surface p-3.5 sm:p-4", current ? "border-ink shadow-card" : "border-line")}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center" aria-hidden="true">
          {status === "done" ? <TickDisc tone="ok" className="size-6" />
            : status === "running" ? <Loader2 className="size-5 motion-safe:animate-spin" />
              : status === "failed" ? <CircleX className="size-6" />
                : <CircleDashed className={clsx("size-5", current ? "text-ink" : "text-ink-2")} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 className="text-body font-semibold" tabIndex={-1} data-focus={r.id === "plan" ? "" : undefined}>
              <span className="tabular-nums text-ink-2">{n}.</span> {t.title}
              <span className="sr-only">: {copy.status[status]}</span>
            </h2>
            {time && <span className="text-small tabular-nums text-ink-2">{time}</span>}
          </div>
          <p className="mt-0.5 break-words text-small text-ink-2">{status === "done" ? doneText(r, copy, run) : describe(r.id, copy, run)}</p>
          {r.id === "claim" && r.status === "done" && r.note?.file ? <p className="text-small text-ink-2">{copy.steps.claim.file}</p> : null}
          {r.id === "review" && r.status === "done" && typeof r.note?.summary === "string" && (
            <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-small">{r.note.summary}</blockquote>
          )}
          {r.id === "sign" && r.note?.topUpFailed ? <Notice tone="warn" className="mt-2"><p>{copy.steps.sign.topUpFailed}</p></Notice> : null}
          {r.txs.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-4">
              {r.txs.map((tx) => (
                <li key={tx.signature} className="min-w-0"><ExplorerLink signature={tx.signature} label={copy.tx.label} srLabel={copy.tx.sr} /></li>
              ))}
            </ul>
          )}
          {busy && <p className="mt-2 text-small font-semibold">{copy.controls.working}</p>}
          {r.status === "failed" && r.error && !busy && (
            <div className="mt-3">
              <Notice tone="danger">
                <p role="alert" className="font-semibold">{errorText(r.error)}</p>
                {r.error.code !== "plan" && (
                  <details className="mt-1">
                    <summary className="min-h-11 cursor-pointer content-center text-ink-2">{copy.errors.details}</summary>
                    <p className="break-words font-mono text-[0.75rem] text-ink-2">{r.error.message}</p>
                  </details>
                )}
              </Notice>
              {!(r.id === "wallet" || r.id === "plan") && (
                <Button className="mt-3" onClick={onRetry}><RotateCcw className="size-4" aria-hidden="true" />{copy.controls.retry}</Button>
              )}
            </div>
          )}
          {panel && <div className="mt-3">{panel}</div>}
        </div>
      </div>
    </li>
  );
}

function describe(id: GuidedStepId, copy: Copy, run: GuidedState): string {
  const p = run.plan;
  const s = copy.steps;
  const chain = run.mode === "chain";
  switch (id) {
    case "wallet": return chain ? s.wallet.chain : s.wallet.mock;
    case "money": return chain ? s.money.chain : s.money.mock;
    case "plan": return fmt(s.plan.body, { perClaim: p.perClaim, total: p.total });
    case "people": return chain ? s.people.chain : s.people.mock;
    case "sign": return s.sign.body;
    case "fund": return fmt(s.fund.body, { amount: p.deposit });
    case "claim": return fmt(s.claim.body, { amount: p.claim });
    case "review": return s.review.body;
    case "approve": return s.approve.body;
    case "pay": return s.pay.body;
    case "cap": return fmt(s.cap.body, { amount: overCapAmount(p), perClaim: p.perClaim });
  }
}

function doneText(r: StepRecord, copy: Copy, run: GuidedState): string {
  const s = copy.steps;
  const note = r.note ?? {};
  const num = (k: string) => Number(note[k] ?? 0).toLocaleString("en-ZA");
  switch (r.id) {
    case "wallet": return fmt(s.wallet.done, { address: shortAddress(String(note.address ?? run.owner ?? ""), 4) });
    case "money": return note.simulated ? fmt(s.money.simulated, { usdt: num("usdt") }) : note.had ? s.money.had : fmt(s.money.done, { usdt: num("usdt") });
    case "plan": return fmt(s.plan.done, { perClaim: run.plan.perClaim, total: run.plan.total });
    case "people": return s.people.done;
    case "sign": return fmt(s.sign.done, { payee: String(note.payee ?? "") });
    case "fund": return fmt(s.fund.done, { amount: run.plan.deposit });
    case "claim": return fmt(s.claim.done, { amount: run.plan.claim });
    case "review": return note.verdict === "Referred" ? s.review.referred : s.review.approved;
    case "approve": return note.already ? s.approve.already : s.approve.done;
    case "pay": return fmt(s.pay.done, { amount: run.plan.claim, payee: String(note.payee ?? "") });
    case "cap": return fmt(s.cap.done, { amount: num("amount"), reason: note.refused === "ExceedsLifetimeCap" ? s.cap.lifetime : s.cap.perClaim });
  }
}

/* ---------- the two steps that ask for something ---------- */

function WalletPanel({ copy, common, name, setName, pin, setPin, pin2, setPin2, consent, setConsent, error, onStart }: {
  copy: Copy; common: ReturnType<typeof useCopy>["common"];
  name: string; setName: (v: string) => void; pin: string; setPin: (v: string) => void; pin2: string; setPin2: (v: string) => void;
  consent: boolean; setConsent: (v: boolean) => void; error: string | null; onStart: (e?: FormEvent) => void;
}) {
  if (MODE === "mock") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-small text-ink-2">{copy.wallet.restartNote}</p>
        <Button onClick={() => onStart()} className="self-start"><Play className="size-5" aria-hidden="true" />{copy.wallet.startMock}</Button>
      </div>
    );
  }
  return (
    <form onSubmit={onStart} noValidate className="flex flex-col gap-3">
      <Field label={copy.wallet.name} htmlFor="guided-name" hint={copy.wallet.nameHint}>
        <input id="guided-name" autoComplete="given-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-describedby="guided-name-hint" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={copy.wallet.pin} htmlFor="guided-pin" hint={copy.wallet.pinHint}>
          <input id="guided-pin" type="password" inputMode="numeric" autoComplete="new-password" required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className={`${inputClass} font-mono tracking-[0.3em]`} aria-describedby="guided-pin-hint" />
        </Field>
        <Field label={copy.wallet.pin2} htmlFor="guided-pin2">
          <input id="guided-pin2" type="password" inputMode="numeric" autoComplete="new-password" required value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} className={`${inputClass} font-mono tracking-[0.3em]`} />
        </Field>
      </div>
      <Consent id="guided-consent" checked={consent} onChange={setConsent} copy={common.consent} />
      {error && <p role="alert" className="flex items-start gap-1.5 text-small font-semibold"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{error}</p>}
      <Button type="submit" className="self-start"><Play className="size-5" aria-hidden="true" />{copy.wallet.start}</Button>
    </form>
  );
}

const PLAN_FIELDS = ["perClaim", "total", "deposit", "claim"] as const;

function PlanPanel({ copy, plan, onUse }: { copy: Copy; plan: SamplePlan; onUse: (p: SamplePlan) => void }) {
  const [vals, setVals] = useState<Record<(typeof PLAN_FIELDS)[number], string>>(() => ({
    perClaim: String(plan.perClaim), total: String(plan.total), deposit: String(plan.deposit), claim: String(plan.claim),
  }));
  const parsed: SamplePlan = {
    perClaim: Number(vals.perClaim), total: Number(vals.total), deposit: Number(vals.deposit), claim: Number(vals.claim),
  };
  const [tried, setTried] = useState(false);
  const problem = checkPlan(parsed, MODE);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!problem) onUse(parsed);
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <dl className="grid gap-x-4 gap-y-1 rounded-md border border-line bg-surface-2 p-3 text-small sm:grid-cols-[auto_1fr]">
        <dt className="font-semibold">{copy.plan.child}</dt><dd>{copy.plan.childValue}</dd>
        <dt className="font-semibold">{copy.plan.payee}</dt><dd>{copy.plan.payeeValue}</dd>
        <dt className="font-semibold">{copy.plan.trusted}</dt><dd>{SAMPLE_TRUSTED.join(", ")}</dd>
        <dt className="font-semibold">{copy.plan.until}</dt><dd>{SAMPLE_UNTIL.slice(0, 4)}</dd>
      </dl>
      <div className="grid grid-cols-2 gap-3">
        {PLAN_FIELDS.map((k) => (
          <Field key={k} label={copy.plan[k]} htmlFor={`guided-${k}`}>
            <input
              id={`guided-${k}`} inputMode="numeric" autoComplete="off" value={vals[k]}
              onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value.replace(/[^\d]/g, "").slice(0, 5) }))}
              className={`${inputClass} tabular-nums`} aria-invalid={tried && !!problem ? true : undefined}
              aria-describedby={tried && problem ? "guided-plan-problem" : undefined}
            />
          </Field>
        ))}
      </div>
      <p className="text-small text-ink-2">{fmt(copy.plan.overCap, { amount: Number.isFinite(parsed.perClaim) ? overCapAmount(parsed) : "" })}</p>
      {tried && problem && <p id="guided-plan-problem" role="alert" className="flex items-start gap-1.5 text-small font-semibold"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{copy.plan.problems[problem]}</p>}
      <Button type="submit" className="self-start">{copy.plan.use}</Button>
    </form>
  );
}
