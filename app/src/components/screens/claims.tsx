"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { AnimatePresence, m as motion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import { ArrowLeft, ArrowRight, Banknote, Check, CircleX, Clock, HandCoins, Plus, Zap } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot } from "@/lib/service";
import type { AgentReport, Claim, Role, WalletSession } from "@/lib/types";
import { formatUsdt, formatUsdtExact, formatZar, toBase } from "@/lib/format";
import { amountHint, amountText, parseAmount } from "@/lib/amount";
import { useEstate } from "@/lib/hooks/estate";
import { Badge, Button, ButtonLink, Card, Consent, EmptyState, ExplorerLink, Field, inputClass, Notice, PageHeader, TickDisc } from "@/components/ui/primitives";
import { FilePicker } from "@/components/ui/client";
import { ReportCard, Reviewing } from "@/components/agent/report-card";
import { Blocked } from "@/components/shell/blocked";
import { usePay } from "@/components/pay/payment";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate } from "@/components/shell/gate";
import { MilestoneMoment } from "@/components/legacy/lazy";
import { categoryIcon } from "./category-icon";
import { PausedNotice } from "@/components/guardians/parts";
import { ClaimWindow } from "@/components/guardians/claim-window";
import { DisputePanel } from "@/components/disputes/disputes";
import { YearlyLeft } from "@/components/disputes/yearly";
import { ask as askEnglish } from "@/content/ask";
import { askStatus } from "@/lib/ask/logic";
import { AskLauncher } from "@/components/ask/launcher";
import { useAskActions } from "@/components/ask/use-ask-actions";
import { useNow } from "@/lib/hooks/use-now";
import { openDisputeOn } from "@/lib/disputes/types";
import { openToPeople, outcomeOf } from "@/lib/verdict";
import { ReferredNote } from "@/components/continuity/continuity";
import { claimBlock, claimPayable, claimTally, isFamily, ownerMayApprove, wasRemoved } from "@/lib/guardians/decisions";
import { ClaimState, useWho, VoteTally } from "@/components/guardians/decision";
import { ReviewAgain } from "@/components/agent/review-again";

type Copy = ScreensCopy["claims"];

/** Animated with motion, so it brings its own <MotionScope> (the first pages never load the library). */
export function ClaimsScreen(props: Parameters<typeof ClaimsScreenBody>[0]) {
  return <MotionScope><ClaimsScreenBody {...props} /></MotionScope>;
}

function ClaimsScreenBody({ copy: english }: { copy: Copy }) {
  const copy = useLocalized(english, (t) => t.screens.claims);
  return <Gate>{({ snap, session, role }) => <Claims copy={copy} snap={snap!} session={session} role={role} />}</Gate>;
}

function Claims({ copy, snap, session, role }: { copy: Copy; snap: EstateSnapshot; session: WalletSession; role: Role }) {
  const { intent, setIntent } = useEstate();
  const { guardians } = useCopy();
  const removed = wasRemoved(snap, session.address);
  const askCopy = useLocalized(askEnglish, (t) => t.ask);
  const e = snap.estate;
  const myRules = snap.rules.filter((r) => r.beneficiary === session.address && r.recurringAmount === BigInt(0));
  const now = useNow(15000);
  const open = (r: (typeof myRules)[number]) => (now === null || now <= r.validUntil) && (e.status === "Unlocked" || (r.startsNow && e.status === "Active"));
  const canClaim = role === "beneficiary" && isFamily(snap, session.address) && myRules.some(open);
  const ownerName = e.ownerName.split(" ")[0];
  const forOwner = role === "owner" ? snap.claims.filter((c) => ownerMayApprove(snap, c, now) && !snap.asks?.[c.address]?.declinedAt) : [];
  const [wizard, setWizard] = useState<{ rule?: string; payee?: string; amount?: number } | null>(null);
  const claims = role === "beneficiary" ? snap.claims.filter((c) => c.beneficiary === session.address) : snap.claims;
  // Family members can see (and dispute) each other's pending payments.
  const family = role === "beneficiary" && !removed ? snap.claims.filter((c) => c.beneficiary !== session.address && c.status === "Open" && openToPeople(c.agentVerdict)) : [];

  useEffect(() => {
    if (!intent || !canClaim) return;
    // Consumes a one-off intent handed over by the agent (an external event), then clears it.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (intent.kind === "claim") { setWizard({ rule: intent.rule, payee: intent.payee, amount: intent.amount }); setIntent(null); }
    else if (intent.kind === "upload" && intent.purpose === "claim") { setWizard({}); setIntent(null); }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [intent, canClaim, setIntent]);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow={copy.eyebrow} title={copy.title} body={copy.body}
        action={role === "beneficiary" && !removed && !wizard ? (
          <div className="flex flex-wrap gap-2">
            {/* Everyday requests ("Ask for money"); the full claim wizard stays for fees with a statement. */}
            <Button variant={canClaim ? "secondary" : "primary"} onClick={() => setIntent({ kind: "ask" })}><HandCoins className="size-5" aria-hidden="true" />{askCopy.entry}</Button>
            {canClaim && <Button onClick={() => setWizard({})}><Plus className="size-5" aria-hidden="true" />{copy.newCta}</Button>}
          </div>
        ) : undefined}
      />
      <AskLauncher />

      <div className="mb-5 empty:hidden"><MilestoneMoment /></div>
      {role === "owner" && (
        <section aria-labelledby="owner-approvals" className="mb-6">
          <h2 id="owner-approvals" className="text-h3">{copy.owner.title}</h2>
          <p className="mb-3 text-small text-ink-2">{copy.owner.body}</p>
          {forOwner.length === 0 ? <p className="text-ink-2">{copy.owner.empty}</p> : (
            <ul className="grid gap-3">{forOwner.map((c) => <OwnerApproval key={c.address} claim={c} snap={snap} copy={copy} />)}</ul>
          )}
        </section>
      )}
      {canClaim && e.status === "Active" && <Notice icon={<Zap className="size-5" aria-hidden="true" />} className="mb-5"><p className="text-body">{fmt(copy.living, { owner: ownerName })}</p></Notice>}
      {removed && <Notice tone="warn" className="mb-5"><p className="text-body">{guardians.rules.blocked.you}</p></Notice>}
      {role === "beneficiary" && !removed && e.status === "Unlocked" && myRules.length > 0 && <Notice tone="ok" className="mb-5"><p className="text-body">{fmt(copy.unlocked, { owner: ownerName })}</p></Notice>}
      {role === "beneficiary" && !removed && !canClaim && myRules.length > 0 && (
        <Notice tone="warn" icon={<Clock className="size-5" aria-hidden="true" />} title={fmt(copy.locked.title, { owner: ownerName })} className="mb-5">
          <p>{fmt(e.status === "DeathPending" ? copy.locked.pending : copy.locked.active, { owner: ownerName })}</p>
          <ButtonLink href="/family" small variant="secondary" className="mt-3">{copy.locked.cta}</ButtonLink>
        </Notice>
      )}
      {role === "beneficiary" && !removed && myRules.length === 0 && <p className="mb-5 text-ink-2">{copy.noRules}</p>}

      <AnimatePresence mode="wait" initial={false}>
        {wizard && canClaim ? (
          <motion.div key="wizard" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
            <Wizard copy={copy} snap={snap} session={session} preset={wizard} onClose={() => setWizard(null)} />
          </motion.div>
        ) : (
          <motion.section key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} aria-labelledby="claims-list">
            <h2 id="claims-list" className="mb-3 text-h3">{role === "beneficiary" ? copy.listTitle : copy.listTitleAll}</h2>
            {claims.length === 0
              ? <EmptyState icon={<Banknote className="size-6" aria-hidden="true" />} title={copy.empty} action={canClaim ? <Button onClick={() => setWizard({})}>{copy.newCta}</Button> : undefined} />
              : <ul className="grid gap-3">{claims.map((c) => <ClaimCard key={c.address} claim={c} snap={snap} copy={copy} />)}</ul>}
            {family.length > 0 && <FamilyPending claims={family} snap={snap} copy={copy} />}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- A claim and its progress ---------- */

export function ClaimTracker({ claim, snap, copy, waitingFor }: { claim: Claim; snap: EstateSnapshot; copy: Copy; waitingFor?: string }) {
  const t = copy.tracker;
  const live = snap.estate.status;
  const approved = claim.ownerApproved || (live === "Unlocked" && claimTally(snap.estate, claim).met);
  const declined = claim.status === "Rejected";
  const steps = [
    { label: t.submitted, done: true },
    { label: declined ? t.declined : t.checked, done: claim.agentVerdict !== "Pending", bad: declined },
    { label: t.approved, done: claim.status === "Paid" || approved, note: !declined && !approved && claim.status === "Open" ? waitingFor : undefined },
    { label: t.paid, done: claim.status === "Paid" },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol aria-label={t.label} className="grid grid-cols-4 gap-1">
      {steps.map((s, i) => (
        <li key={s.label} className="flex flex-col items-center gap-1 text-center" aria-current={i === current && !declined ? "step" : undefined}>
          <div className="flex w-full items-center">
            <span className={clsx("h-0.5 flex-1", i === 0 ? "bg-transparent" : steps[i].done ? "bg-accent" : "bg-line")} aria-hidden="true" />
            <motion.span
              initial={false} animate={{ scale: s.done ? [1, 1.2, 1] : 1 }} transition={{ duration: 0.4 }}
              className={clsx("grid size-7 shrink-0 place-items-center rounded-full border-2", s.bad ? "rounded-[3px]! border-ink bg-ink text-bg" : s.done ? "border-ink bg-ink text-bg" : i === current && !declined ? "border-dashed border-ink bg-surface" : "border-line bg-surface")}
              aria-hidden="true"
            >
              {s.bad ? <CircleX className="size-4" /> : s.done ? <Check className="size-4" /> : i === current && !declined ? <span className="size-2 animate-pulse-soft rounded-full bg-ink" /> : null}
            </motion.span>
            <span className={clsx("h-0.5 flex-1", i === steps.length - 1 ? "bg-transparent" : steps[i + 1].done ? "bg-accent" : "bg-line")} aria-hidden="true" />
          </div>
          <span className={clsx("text-[0.7rem] font-semibold leading-tight", s.bad ? "text-ink underline decoration-2 underline-offset-2" : s.done ? "text-ink" : "text-ink-2")}>{s.label}<span className="sr-only">{s.done ? " ✓" : ""}</span></span>
          {s.note && <span className="text-[0.7rem] leading-tight text-ink-2">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function ClaimCard({ claim, snap, copy }: { claim: Claim; snap: EstateSnapshot; copy: Copy }) {
  const { common, guardians } = useCopy();
  const { fx, session } = useEstate();
  const nameOf = useWho(snap);
  const now = useNow(15000);
  const rate = fx?.usdtZar ?? null;
  const rule = claim.fromEndedRule ? undefined : snap.rules.find((r) => r.address === claim.rule);
  const payee = nameOf(claim.payee);
  const who = snap.beneficiaries.find((b) => b.wallet === claim.beneficiary)?.label ?? nameOf(claim.beneficiary);
  const block = claim.status === "Open" ? claimBlock(snap, claim, now) : null;
  const unlocked = snap.estate.status === "Unlocked";
  const Icon = rule ? categoryIcon[rule.category] : Banknote;
  const askCopy = useLocalized(askEnglish, (t) => t.ask);
  const note = snap.asks?.[claim.address];
  const declined = askStatus(claim, snap.estate, note) === "declined";
  const tone = claim.status === "Paid" ? "ok" : claim.status === "Rejected" || declined || block ? "danger" : "warn";
  return (
    <motion.li layout className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-surface-2 text-amber"><Icon className="size-5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold tabular-nums">{formatUsdt(claim.amount)}{rate ? <span className="block text-small font-normal text-ink-2">≈ {formatZar(claim.amount, rate)}</span> : null}</p>
          <p className="text-small text-ink-2">{fmt(copy.card.to, { payee })} · {fmt(copy.card.forWho, { name: who })}</p>
          {note?.purpose && <p className="text-small font-medium">{fmt(askCopy.line.for, { purpose: note.purpose })}</p>}
        </div>
        <Badge tone={tone}>{declined ? askCopy.status.declined : block ? guardians.rules.blocked.badge : common.status.claim[claim.status]}</Badge>
      </div>
      {claim.status === "Open" && <ReferredNote verdict={claim.agentVerdict} />}
      {claim.status === "Open" && claim.agentVerdict === "Pending" && claim.beneficiary === session?.address && (
        <ReviewAgain kind="claim" subject={claim.address} noFile={note?.attachment === false} className="mt-3" />
      )}
      {declined ? <p className="mt-3 text-small font-semibold">{fmt(askCopy.line.declined, { owner: snap.estate.ownerName.split(" ")[0] })}</p> : <div className="mt-4"><ClaimTracker claim={claim} snap={snap} copy={copy} waitingFor={!block && snap.estate.status === "Active" && rule?.startsNow ? fmt(copy.card.waitingOwner, { owner: snap.estate.ownerName.split(" ")[0] }) : undefined} /></div>}
      {claim.status === "Open" && unlocked && !block && !claim.ownerApproved && openToPeople(claim.agentVerdict) && (
        <div className="mt-3"><VoteTally tally={claimTally(snap.estate, claim)} names={snap.estate.verifierNames} /></div>
      )}
      {!declined && <ClaimState snap={snap} claim={claim} />}
      {claim.status === "Open" && !block && <PausedNotice target={claim.address} className="mt-3" />}
      {!declined && !block && <DisputePanel kind="Claim" target={claim.address} className="mt-3" />}
      {unlocked && claimPayable(snap, claim, now) && (
        <ClaimWindow claim={claim.address} payee={claim.payee} payeeName={payee} amount={claim.amount} successText={fmt(copy.card.paidOn, { payee })} />
      )}
      {claim.status === "Paid" && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-md border-[1.5px] border-ink bg-surface p-3">
          <p className="flex items-center gap-2 font-semibold"><TickDisc className="size-5" />{fmt(copy.card.paidOn, { payee })}</p>
          {rate && <p className="mt-1 flex flex-wrap items-center gap-2 text-small">{fmt(copy.card.settlement, { zar: formatZar(claim.amount, rate), payee })}<Badge tone="warn">{copy.card.simulated}</Badge></p>}
          <p className="text-[0.75rem] text-ink-2">{copy.card.settlementNote}</p>
          {claim.txSignature && <ExplorerLink signature={claim.txSignature} label={copy.card.receipt} srLabel={copy.card.receiptSr} />}
        </motion.div>
      )}
      {claim.agentReport && claim.status !== "Paid" && (
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-small font-semibold text-accent">{copy.card.report}</summary>
          <ReportCard report={claim.agentReport} compact />
        </details>
      )}
    </motion.li>
  );
}

/** Other family members' pending payments: shown so a family member can dispute one (U9). */
function FamilyPending({ claims, snap, copy }: { claims: Claim[]; snap: EstateSnapshot; copy: Copy }) {
  const { disputes } = useCopy();
  return (
    <section aria-labelledby="family-pending" className="mt-6">
      <h2 id="family-pending" className="text-h3">{disputes.family.title}</h2>
      <p className="mb-3 text-small text-ink-2">{disputes.family.body}</p>
      <ul className="grid gap-3">{claims.map((c) => <ClaimCard key={c.address} claim={c} snap={snap} copy={copy} />)}</ul>
    </section>
  );
}

/* ---------- New claim wizard ---------- */

function Wizard({ copy, snap, session, preset, onClose }: { copy: Copy; snap: EstateSnapshot; session: WalletSession; preset: { rule?: string; payee?: string; amount?: number }; onClose: () => void }) {
  const { common } = useCopy();
  const { fx, run, busy } = useEstate();
  const w = copy.wizard;
  const rate = fx?.usdtZar ?? null;
  const live = snap.estate.status;
  const nowS = useNow(15000);
  const usable = (r: { startsNow: boolean; validUntil: number }) => (nowS === null || nowS <= r.validUntil) && (live === "Unlocked" || (r.startsNow && live === "Active"));
  const rules = snap.rules.filter((r) => r.beneficiary === session.address && r.recurringAmount === BigInt(0)).sort((a, b) => Number(usable(b)) - Number(usable(a)));
  const [ruleAddr, setRuleAddr] = useState(preset.rule && rules.some((r) => r.address === preset.rule && usable(r)) ? preset.rule : rules.filter(usable).length === 1 ? rules.filter(usable)[0].address : "");
  const rule = rules.find((r) => r.address === ruleAddr);
  const payees = rule ? snap.payees.filter((p) => p.kind === rule.allowedPayeeKind) : [];
  const [picked, setPayee] = useState(preset.payee ?? "");
  // With only one approved payee for the rule, it is chosen for the user.
  const payee = picked || (payees.length === 1 ? payees[0].wallet : "");
  const [amount, setAmount] = useState(preset.amount ? amountText(preset.amount) : "");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [step, setStep] = useState(preset.rule && preset.payee ? 2 : preset.rule ? 1 : 0);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<{ report: AgentReport; claim: string } | null>(null);

  const n = parseAmount(amount) ?? Number.NaN;
  const validAmount = Number.isFinite(n) && n > 0;
  const left = rule ? rule.lifetimeCap - rule.spentTotal : BigInt(0);
  const payeeName = snap.payees.find((p) => p.wallet === payee)?.name ?? "";

  const next = () => {
    if (step === 0 && !rule) return;
    if (step === 1 && !payee) return;
    if (step === 2 && !validAmount) { setError(amount.trim() && Number.isNaN(n) ? common.amountUnclear : w.amount.error); return; }
    setError(null);
    setStep((s) => s + 1);
  };

  const submit = async () => {
    if (!rule) return;
    if (!file) { setError(w.evidence.needFile); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null); setBlocked(null);
    const res = await run("claim", (s, est) => s.submitClaim(est, { rule: rule.address, payee, amountUsdt: n, evidence: file }), undefined, true);
    if (res.ok) setResult({ report: res.value.report, claim: res.value.claim });
    else setBlocked({ code: res.code, message: res.message });
  };

  if (busy === "claim") return <Reviewing />;

  if (result) {
    const claim = snap.claims.find((c) => c.address === result.claim);
    // Only a rejection stops a claim: a referred one is submitted, and people decide it.
    const outcome = outcomeOf(result.report.verdict);
    const ok = outcome !== "Reject";
    return (
      <Card>
        <h2 className="text-h3" role="status">{ok ? copy.result.submitted : copy.result.declined}</h2>
        {outcome !== "Refer" && <p className="mt-1 text-ink-2">{!ok ? copy.result.declinedBody : live === "Active" ? fmt(copy.result.submittedBodyOwner, { owner: snap.estate.ownerName.split(" ")[0] }) : copy.result.submittedBody}</p>}
        {outcome === "Refer" && <ReferredNote verdict="Referred" />}
        {claim && <div className="mt-4"><ClaimTracker claim={claim} snap={snap} copy={copy} /></div>}
        <div className="mt-4"><ReportCard report={result.report} /></div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={onClose}>{copy.listTitle}</Button>
          <Button variant="secondary" onClick={() => { setResult(null); setFile(null); setConsent(false); setStep(0); setAmount(""); }}>{copy.result.another}</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-h3">{w.title}</h2>
        <Button variant="ghost" small onClick={onClose}>{w.cancel}</Button>
      </div>
      <ol className="mt-3 flex gap-1.5" aria-label={fmt(w.stepLabel, { n: step + 1, name: w.steps[step] })}>
        {w.steps.map((s, i) => (
          <li key={s} className="flex flex-1 flex-col gap-1" aria-current={i === step ? "step" : undefined}>
            <span className={clsx("h-1.5 rounded-full transition-colors", i <= step ? "bg-accent" : "bg-line")} />
            <span className={clsx("text-[0.7rem] font-semibold", i === step ? "text-ink" : "text-ink-2")}>{s}</span>
          </li>
        ))}
      </ol>

      <div className="mt-5 min-h-48">
        {step === 0 && (
          <fieldset>
            <legend className="mb-2 font-semibold">{w.rule.legend}</legend>
            <div className="grid gap-2">
              {rules.map((r) => {
                const Icon = categoryIcon[r.category];
                return (
                  <label key={r.address} className={clsx("flex min-h-16 cursor-pointer items-center gap-3 rounded-md border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]", ruleAddr === r.address ? "border-accent bg-accent-soft" : "border-line-strong", !usable(r) && "cursor-not-allowed opacity-60")}>
                    <input type="radio" name="claim-rule" className="sr-only" disabled={!usable(r)} checked={ruleAddr === r.address} onChange={() => { setRuleAddr(r.address); setPayee(""); }} />
                    <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-surface-2 text-amber"><Icon className="size-5" aria-hidden="true" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 font-semibold">{common.status.category[r.category]}<Badge tone={r.startsNow ? "gold" : "neutral"}>{r.startsNow ? w.rule.now : w.rule.later}</Badge></span>
                      {!usable(r) && <span className="block text-small font-medium text-amber-ink">{fmt(w.rule.notYet, { owner: snap.estate.ownerName.split(" ")[0] })}</span>}
                      <span className="block text-small text-ink-2">{fmt(w.rule.left, { amount: formatUsdt(r.lifetimeCap - r.spentTotal, { decimals: 0 }) })} · {fmt(w.rule.perClaim, { amount: formatUsdt(r.maxPerClaim, { decimals: 0 }) })}</span>
                      <YearlyLeft rule={r} className="block text-small text-ink-2" />
                    </span>
                    {ruleAddr === r.address && <Check className="size-5 shrink-0 text-amber" aria-hidden="true" />}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {step === 1 && (
          <fieldset>
            <legend className="mb-1 font-semibold">{w.payee.legend}</legend>
            <p className="mb-2 text-small text-ink-2">{w.payee.hint}</p>
            {payees.length === 0 ? <p className="text-ink-2">{w.payee.none}</p> : (
              <div className="grid gap-2">
                {payees.map((p) => (
                  <label key={p.wallet} className={clsx("flex min-h-14 cursor-pointer items-center gap-3 rounded-md border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]", payee === p.wallet ? "border-accent bg-accent-soft" : "border-line-strong")}>
                    <input type="radio" name="claim-payee" className="sr-only" checked={payee === p.wallet} onChange={() => setPayee(p.wallet)} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{p.name}</span>
                      <span className="block text-small text-ink-2">{common.status.payeeKind[p.kind]}</span>
                    </span>
                    {payee === p.wallet && <Check className="size-5 shrink-0 text-amber" aria-hidden="true" />}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {step === 2 && rule && (
          <div className="flex flex-col gap-3">
            <Field label={w.amount.label} htmlFor="claim-amount" error={error} hint={amountHint(amount, (x) => (x > 0 ? `= ${formatUsdtExact(toBase(x))}${rate ? ` · ${fmt(w.amount.hint, { zar: formatZar(toBase(x), rate), max: formatUsdt(rule.maxPerClaim, { decimals: 0 }) })}` : ""}` : undefined), { unclear: common.amountUnclear, format: common.amountFormat })}>
              <div className="relative">
                <input
                  id="claim-amount" inputMode="decimal" autoComplete="off" placeholder="0" autoFocus value={amount}
                  onChange={(ev) => { setAmount(ev.target.value); setError(null); setBlocked(null); }}
                  aria-invalid={!!error} aria-describedby={error ? "claim-amount-error" : "claim-amount-hint"}
                  className={`${inputClass} min-h-16 pr-20 font-display text-h2 tabular-nums`}
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-ink-2">USD₮</span>
              </div>
            </Field>
            {validAmount && toBase(n) > rule.maxPerClaim && <Notice tone="warn"><p role="status">{fmt(w.amount.over, { max: formatUsdt(rule.maxPerClaim, { decimals: 0 }) })}</p></Notice>}
            {validAmount && toBase(n) <= rule.maxPerClaim && toBase(n) > left && <Notice tone="warn"><p role="status">{fmt(w.amount.overLeft, { left: formatUsdt(left, { decimals: 0 }) })}</p></Notice>}
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-4">
            <p className="rounded-md bg-surface-2 px-3.5 py-2.5 font-semibold">{fmt(w.summary, { amount: formatUsdtExact(toBase(n || 0)), payee: payeeName })}</p>
            <FilePicker id="claim-evidence" label={w.evidence.label} hint={w.evidence.hint} file={file} onFile={(f) => { setFile(f); setError(null); }} samples={w.evidence.samples} copy={common.file} />
            <Consent id="claim-consent" checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
            {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
            {blocked && (
              <Blocked code={blocked.code} message={blocked.message}>
                {blocked.code !== "ReviewPending" && <Button small variant="secondary" onClick={() => { setBlocked(null); setStep(2); }}>{copy.result.tryAgain}</Button>}
              </Blocked>
            )}
          </div>
        )}
      </div>

      <div className="mt-5 flex gap-3">
        {step > 0 && <Button variant="secondary" onClick={() => { setError(null); setStep((s) => s - 1); }}><ArrowLeft className="size-4" aria-hidden="true" />{w.back}</Button>}
        {step < 3
          ? <Button className="flex-1" onClick={next} disabled={(step === 0 && !rule) || (step === 1 && !payee)}>{w.next}<ArrowRight className="size-5" aria-hidden="true" /></Button>
          : <Button className="flex-1" onClick={submit}>{w.submit}</Button>}
      </div>
    </Card>
  );
}

/* ---------- Owner: approve a living-plan claim, then the vault pays the institution ---------- */

function OwnerApproval({ claim, snap, copy }: { claim: Claim; snap: EstateSnapshot; copy: Copy }) {
  const { common, disputes } = useCopy();
  // An open dispute pauses the payment (execute_claim refuses), so the card shows the dispute instead of a failing pay.
  const now = useNow();
  const paused = !!openDisputeOn(snap.disputes, claim.address, now ?? 0);
  const { fx, busy } = useEstate();
  const { pay } = usePay();
  const { decline } = useAskActions();
  const askCopy = useLocalized(askEnglish, (t) => t.ask);
  const note = snap.asks?.[claim.address];
  const rate = fx?.usdtZar ?? null;
  const rule = snap.rules.find((r) => r.address === claim.rule);
  const nameOf = useWho(snap);
  const payee = nameOf(claim.payee);
  const who = snap.beneficiaries.find((b) => b.wallet === claim.beneficiary)?.label ?? nameOf(claim.beneficiary);
  return (
    <motion.li layout className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <p className="text-h3 font-display tabular-nums">{formatUsdt(claim.amount)}{rate ? <span className="ml-2 font-sans text-small text-ink-2">≈ {formatZar(claim.amount, rate)}</span> : null}</p>
      <p className="font-semibold">{fmt(copy.card.to, { payee })}</p>
      <p className="text-small text-ink-2">{fmt(copy.owner.forWho, { name: who, category: rule ? common.status.category[rule.category].toLowerCase() : "" })}</p>
      {note?.purpose && <p className="mt-1 font-medium">{fmt(askCopy.line.for, { purpose: note.purpose })}</p>}
      {claim.agentReport && <div className="mt-3"><ReportCard report={claim.agentReport} compact /></div>}
      <DisputePanel kind="Claim" target={claim.address} className="mt-3" />
      {paused && <p className="mt-3 text-small text-ink-2">{disputes.card.payPaused}</p>}
      <Button
        className="mt-3" block disabled={!!busy || paused}
        onClick={() => {
          // Skip the approval if it already went through on an earlier attempt (the program rejects a second one).
          // Tracked here too, because "Try again" in the payment sheet re-runs this same function before the snapshot refreshes.
          let approved = claim.ownerApproved;
          void pay({
            kind: "claim-payout", source: "vault", to: claim.payee, toLabel: payee, amount: claim.amount, ...(claim.ownerApproved ? {} : { approve: "owner" as const, claim: claim.address }),
            execute: async (svc, est, again) => {
              // A first try that was still being checked may have approved it: read it again rather than approve twice.
              if (!approved && again) approved = !!(await svc.getEstate(est)).claims.find((x) => x.address === claim.address)?.ownerApproved;
              if (!approved) { await svc.ownerApproveClaim(est, claim.address); approved = true; }
              return svc.executeClaim(est, claim.address);
            },
            successText: fmt(copy.owner.done, { payee }),
          });
        }}
      >
        <Check className="size-5" aria-hidden="true" />{copy.owner.approve}
      </Button>
      {!claim.ownerApproved && (
        <Button className="mt-2" block variant="secondary" disabled={!!busy} loading={busy === `decline:${claim.address}`} onClick={() => void decline(claim.address)}>
          <CircleX className="size-5" aria-hidden="true" />{askCopy.claims.decline}
        </Button>
      )}
    </motion.li>
  );
}
