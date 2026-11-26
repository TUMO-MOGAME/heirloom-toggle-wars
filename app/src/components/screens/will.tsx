"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, CalendarClock, CarFront, Check, Clock, GraduationCap, Hourglass, Lock, PenLine, Phone, ShieldCheck, Sparkles, UsersRound, X, Zap } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocale, useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot, TxResult } from "@/lib/service";
import type { WalletSession, WillChatMessage, WillDraft } from "@/lib/types";
import type { CreateEstateOptions } from "@/lib/continuity/types";
import { formatUsdt, fromBase, shortAddress, toBase } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { Badge, Button, ButtonLink, Card, Consent, Eyebrow, ExplorerLink, Notice, PageHeader } from "@/components/ui/primitives";
import { Bubble, Chips, Composer, Thinking } from "@/components/agent/chat-parts";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate } from "@/components/shell/gate";
import { categoryIcon } from "./category-icon";
import { FallbackPlanCard } from "@/components/guardians/fallback";
import { GuardiansPlanLink } from "@/components/guardians/section";
import { BillTemplates } from "@/components/everyday/bill-templates";
import { WillLettersCard } from "@/components/letters/lazy";
import { FRESH_ATTR, firstDemoPersona } from "@/lib/service/fresh-visit";
import { ruleKey, signedEvery, waitingSecsFor, waitingText, withOwnerSummary } from "@/lib/will-summary";
import { clockOf, clockText, ruleClock, scheduleSecs } from "@/lib/schedule-clock";
import { MIN_DEATH_WAITING_SECS } from "@/lib/continuity/logic";
import { isMockService } from "@/lib/service/is-mock";
import { willView } from "@/lib/hooks/pick-estate";
import { ConnectPeople, EndRule, ResidualPicker } from "@/components/continuity/continuity";
import { NamesNotice } from "@/components/continuity/names-notice";
import { checkTrusted, missingPayees, missingPeople, paidOnRequest, withWallets } from "@/lib/continuity/practice";
import { SetupChecks } from "@/components/continuity/setup-checks";
import { useWho } from "@/components/guardians/decision";
import { DEMO_PAYEES } from "@/lib/service/mock-payees";
import { trackPlanEvent, usePlanVariant } from "@/lib/experiments/use-variant";

type Copy = ScreensCopy["will"];
type BillsCopy = ScreensCopy["bills"];
interface Msg extends WillChatMessage { id: number; fresh?: boolean }
const usd = (n: number) => formatUsdt(toBase(n), { decimals: 0 });
const longDate =(iso: string | number) => new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });

/** The schedule's interval as a preview word (the demo clock repeats every 60 seconds, shown as "minute"). */
/** The waiting period as this estate will get it (demo clock or NEXT_PUBLIC_DEMO_WAITING_SECS), not only the days drafted. */
function useWaitPeriod(copy: Copy) {
  const { service } = useEstate();
  const mode = isMockService(service) ? "mock" : "chain";
  // What the plan will really get (M5): a wait shorter than the program allows is signed as the shortest one.
  return (days: number) => {
    const secs = waitingSecsFor(days, mode);
    return mode === "chain" && secs === MIN_DEATH_WAITING_SECS && days * 86_400 < MIN_DEATH_WAITING_SECS ? fmt(copy.preview.periodMin, { secs }) : waitingText(secs, copy.preview);
  };
}

/** How a schedule chosen as `every` will really repeat here (H10): the demo clock, a test site's, or as chosen. */
function useScheduleClock() {
  const { service } = useEstate();
  const mode = isMockService(service) ? "mock" : "chain";
  return (every: NonNullable<WillDraft["rules"][number]["recurring"]>["every"]) => clockOf(scheduleSecs(every, mode), every);
}

export function WillScreen({ copy: english, bills: billsEnglish }: { copy: Copy; bills: BillsCopy }) {
  const copy = useLocalized(english, (t) => t.screens.will);
  const bills = useLocalized(billsEnglish, (t) => t.screens.bills);
  return (
    // A first demo visit is Thabo with no plan yet, so the conversation's opening screen is server-rendered.
    <Gate roles={["owner"]} allowEmpty fresh={<WillFlow copy={copy} bills={bills} snap={null} session={firstDemoPersona()} firstVisit />}>
      {({ snap, session }) => <WillFlow copy={copy} bills={bills} snap={snap} session={session} />}
    </Gate>
  );
}

function WillFlow({ copy, bills, snap, session, firstVisit }: { copy: Copy; bills: BillsCopy; snap: EstateSnapshot | null; session: WalletSession; firstVisit?: boolean }) {
  // Kept here so the "locked in" moment survives the estate appearing underneath it.
  const [txs, setTxs] = useState<TxResult[] | null>(null);
  const [topUpFailed, setTopUpFailed] = useState(false);
  // A plan this wallet started signing that isn't all on-chain yet (H6). Looked up again when the estate changes.
  const { service } = useEstate();
  const [unfinished, setUnfinished] = useState<{ draft: WillDraft; options: CreateEstateOptions } | null>(null);
  const [fresh, setFresh] = useState(false);
  const snapKey = snap ? `${snap.estate.address}:${snap.estate.willHash}:${snap.rules.length}:${snap.beneficiaries.length}` : "none";
  useEffect(() => {
    if (!service || firstVisit) return;
    let live = true;
    service.unfinishedSigning().then((u) => { if (live) setUnfinished(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [service, session.address, snapKey, firstVisit]);
  // A family member or trusted person who plans for her own family sees the estate she belongs to here; this page
  // is about her own plan, so she is offered the plan builder (on chain it creates an estate owned by her wallet).
  const [ownPlan, setOwnPlan] = useState(false);
  const { chooseEstate, estates } = useEstate();
  const signed = (r: { estate: string; txs: TxResult[]; topUpFailed?: boolean }) => { setTxs(r.txs); setTopUpFailed(!!r.topUpFailed); setUnfinished(null); chooseEstate(r.estate); };
  const view = willView(snap?.estate.owner ?? null, session.address, estates, snap?.estate.address ?? null);
  if (txs) return <Done copy={copy} txs={txs} topUpFailed={topUpFailed} />;
  if (unfinished && !fresh && (!snap || view.kind === "locked")) {
    return <FinishSigning copy={copy} plan={unfinished} onSigned={signed} onFresh={snap ? undefined : () => setFresh(true)} />;
  }
  if (snap && view.kind === "locked") return <Locked copy={copy} bills={bills} snap={snap} />;
  if (snap && view.kind !== "builder" && !(view.kind === "startOwn" && ownPlan)) {
    return <NotYourPlan copy={copy} snap={snap} session={session} own={view.kind === "openOwn" ? view.estate : null} onStart={() => setOwnPlan(true)} />;
  }
  return <Writer copy={copy} bills={bills} session={session} onSigned={signed} firstVisit={firstVisit} />;
}

/** The estate on screen belongs to someone else: open her own plan if she has one, else start one. */
function NotYourPlan({ copy, snap, session, own, onStart }: { copy: Copy; snap: EstateSnapshot; session: WalletSession; own: string | null; onStart: () => void }) {
  const { chooseEstate } = useEstate();
  const n = copy.notYours;
  const name = snap.estate.ownerName;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader eyebrow={copy.eyebrow} title={fmt(n.title, { name })} body={fmt(own ? n.bodyOwn : n.body, { name, me: session.label.split(/[ (]/)[0] })} />
      <div className="flex flex-col gap-3 sm:flex-row">
        {own
          ? <Button onClick={() => chooseEstate(own)}>{n.openOwn}<ArrowRight className="size-5" aria-hidden="true" /></Button>
          : <Button onClick={onStart}><PenLine className="size-5" aria-hidden="true" />{n.start}</Button>}
        <ButtonLink href="/estate" variant="secondary">{fmt(n.view, { name: name.split(" ")[0] })}</ButtonLink>
      </div>
    </div>
  );
}

/** "Finish signing": the same plan again, which adds only what the chain is missing (H6). */
function FinishSigning({ copy, plan, onSigned, onFresh }: {
  copy: Copy; plan: { draft: WillDraft; options: CreateEstateOptions }; onSigned: (r: { estate: string; txs: TxResult[]; topUpFailed?: boolean }) => void; onFresh?: () => void;
}) {
  const { run, busy } = useEstate();
  const f = copy.finish;
  const finish = async () => {
    const res = await run("sign", (s) => s.createEstateFromWill(plan.draft, plan.options));
    if (res.ok) onSigned(res.value);
  };
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader eyebrow={copy.eyebrow} title={f.title} body={f.body} />
      <Card>
        <h2 className="text-h3">{f.summary}</h2>
        <p className="mt-2 whitespace-pre-line">{plan.draft.plainLanguageSummary}</p>
      </Card>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Button onClick={() => void finish()} loading={busy === "sign"} disabled={!!busy}><Lock className="size-5" aria-hidden="true" />{f.cta}</Button>
        {onFresh && <Button variant="secondary" onClick={onFresh} disabled={!!busy}>{f.again}</Button>}
      </div>
    </div>
  );
}

function Done({ copy, txs, topUpFailed = false }: { copy: Copy; txs: TxResult[]; topUpFailed?: boolean }) {
  return (
    <div className="enter mx-auto max-w-xl text-center [--enter-dur:0.35s] [--from-s:0.97] [--from-y:0]">
      <span className="spring-pop mx-auto grid size-20 place-items-center rounded-full bg-accent text-accent-ink [--enter-delay:0.1s] [--from-s:0]">
        <Lock className="size-9" aria-hidden="true" />
      </span>
      <h1 className="mt-5 text-h1" role="status">{copy.done.title}</h1>
      <p className="mt-3 text-lead text-ink-2">{copy.done.body}</p>
      {topUpFailed && <Notice tone="warn" className="mt-4 text-left"><p role="status">{copy.done.topUp}</p></Notice>}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
        <ButtonLink href="/vault">{copy.done.fund}<ArrowRight className="size-5" aria-hidden="true" /></ButtonLink>
        <ButtonLink href="/car" variant="secondary">{copy.done.car}</ButtonLink>
        <ButtonLink href="/estate" variant="ghost">{copy.done.estate}</ButtonLink>
      </div>
      {txs.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5">
          <span className="text-small text-ink-2">{copy.done.receipts}</span>
          {txs.map((t, i) => <ExplorerLink key={t.signature} signature={t.signature} label={fmt(copy.done.receipt, { n: i + 1 })} srLabel={copy.done.receiptSr} />)}
        </div>
      )}
    </div>
  );
}

/* ---------- Conversation + live preview + review + sign ---------- */

const scheduleKey = (r: WillDraft["rules"][number]) => `${r.beneficiaryLabel}|${r.category}|${r.recurring?.payeeName ?? ""}`;

/** `firstVisit`: the server-rendered copy shown to a first demo visit before the app loads (see Gate `fresh`). */
function Writer({ copy, bills, session, onSigned, firstVisit = false }: { copy: Copy; bills: BillsCopy; session: WalletSession; onSigned: (r: { estate: string; txs: TxResult[] }) => void; firstVisit?: boolean }) {
  // The opening message fades in with CSS, so the server-rendered first visit shows it without JavaScript. When this
  // writer replaces that copy, the message is already on screen and appears without a second fade.
  const [greetingEnter] = useState<"css" | "none">(() => (!firstVisit && typeof document !== "undefined" && document.documentElement.hasAttribute(FRESH_ATTR) ? "none" : "css"));
  const locale = useLocale();
  const { common, assistant } = useCopy();
  const { service, run, busy, openAgent, isMock } = useEstate();
  const [wallets, setWallets] = useState<Record<string, string>>({});
  const [practice, setPractice] = useState(false);
  // Schedules the owner chose to pay on request, by who + what + payee: the only way one stops being scheduled (U2).
  const [onRequest, setOnRequest] = useState<string[]>([]);
  const [payeeRefused, setPayeeRefused] = useState(false);
  // Bumped when the owner clears the addresses, so the address boxes start empty.
  const [addressRound, setAddressRound] = useState(0);
  const [residualLabel, setResidualLabel] = useState("");
  const first = session.label.split(/[ (]/)[0];
  // The greeting (message 0) follows the current language and name: this writer can be the first-visit copy that was
  // rendered before the visitor's language loaded.
  const greeting = fmt(copy.greeting, { name: first });
  const [messages, setMessages] = useState<Msg[]>([{ id: 0, role: "agent", text: greeting }]);
  const textOf = (m: Msg) => (m.id === 0 ? greeting : m.text);
  const [rawDraft, setDraft] = useState<WillDraft | null>(null);
  // The owner's own Now / After-I'm-gone choices, kept when the agent sends a fresh draft.
  // Keyed by who + what (not row position), so a re-ordered or extended draft can't move a choice onto another rule.
  const [starts, setStarts] = useState<Record<string, boolean>>({});
  // Rules the owner added from a bill template: kept beside the agent's draft, so a fresh draft doesn't drop them.
  const [extra, setExtra] = useState<WillDraft["rules"]>([]);
  // When the owner's Now / After choices (or a ready-made bill) change the timing, the agent's summary no longer fits:
  // the summary shown on the review and hashed into the signed will is then written from the rules (lib/will-summary).
  const owned = useMemo(() => {
    if (!rawDraft) return null;
    const rules = [...rawDraft.rules, ...extra].map((r) => {
      const k = ruleKey(r);
      const timed = k in starts ? { ...r, startsNow: starts[k] } : r;
      return onRequest.includes(scheduleKey(r)) ? paidOnRequest(timed) : timed;
    });
    const out = withOwnerSummary(rawDraft, rules, copy.review, {
      category: (c) => common.status.category[c], every: (e) => copy.review.summaryEvery[e], usd, need: 2,
    });
    // On a fast clock the signed summary says so (H10): "every month" would be signed as every 60 seconds.
    const fast = rules.map((r) => r.recurring && clockOf(scheduleSecs(r.recurring.every, isMock ? "mock" : "chain"), r.recurring.every)).find((c) => c?.fast);
    // A wait shorter than the program allows is signed as the shortest one (M5): the signed text says so too.
    const waitSecs = waitingSecsFor(rawDraft.waitingPeriodDays, isMock ? "mock" : "chain");
    const clamped = !isMock && rawDraft.waitingPeriodDays * 86_400 < waitSecs;
    if (!fast && !clamped) return out;
    const note = [fast && fmt(copy.review.summaryClock, { secs: fast.secs }), clamped && `${copy.preview.waiting}: ${fmt(copy.preview.periodMin, { secs: waitSecs })}.`].filter(Boolean).join(" ");
    return { ...out, draft: { ...out.draft, plainLanguageSummary: `${out.draft.plainLanguageSummary.slice(0, 2000 - note.length - 1)} ${note}`.trim() } };
  }, [rawDraft, extra, starts, onRequest, copy, common, isMock]);
  const draft: WillDraft | null = owned?.draft ?? null;
  const addBill = (rule: WillDraft["rules"][number]) => {
    setExtra((x) => [...x, rule]);
    // The form's own Now / After choice wins over an older toggle on a rule with the same key.
    setStarts((prev) => ({ ...prev, [ruleKey(rule)]: rule.startsNow }));
  };
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [view, setView] = useState<"chat" | "review">("chat");
  const id = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  // Scroll only the chat's own message pane, never the page, so the layout stays put while chatting.
  // While a reply types out, follow it only if the reader is already near the bottom (don't yank them back up).
  // "pinned" = the reader is at the bottom; updated only by the reader's own scrolling, so long typed lines can't unpin it.
  const pinned = useRef(true);
  const stickToEnd = useCallback((force: boolean) => {
    const el = log.current;
    if (!el) return;
    if (force) pinned.current = true;
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    let last = el.scrollTop;
    const onScroll = () => {
      // Only an upward scroll by the reader unpins; reaching the bottom again re-pins.
      if (el.scrollTop < last - 4) pinned.current = false;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) pinned.current = true;
      last = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [view]);
  // Switching between the conversation and the review starts at the top of the page,
  // and coming back to the conversation shows its latest message.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    window.scrollTo({ top: 0 });
    if (view === "chat") requestAnimationFrame(() => stickToEnd(true));
  }, [view, stickToEnd]);
  const scroll = useCallback(() => stickToEnd(false), [stickToEnd]);
  useEffect(() => {
    if (messages.length > 1 || pending) requestAnimationFrame(() => stickToEnd(true));
  }, [messages.length, pending, stickToEnd]);

  const turns = messages.filter((m) => m.role === "user").length;
  // An asset is optional: most families have no car to put in a plan.
  const complete = !!draft && draft.beneficiaries.length > 0 && draft.verifiers.length >= 3 && draft.rules.length > 0;
  // The experiment (plan §2): `blank` hides only the suggested replies. The exposure is sent when this conversation
  // screen renders with Flagsmith's settled value (before consent); a reply area revealed before that locks control.
  const variant = usePlanVariant(view === "chat", consent || turns > 0);
  const reviewing = view === "review" && !!draft;
  useEffect(() => { if (reviewing) trackPlanEvent("plan_reviewed"); }, [reviewing]);

  // `base` lets a retry resend from the history *without* the failed message (state updates aren't visible yet).
  const send = async (text: string, base: Msg[] = messages) => {
    const trimmed = text.trim();
    if (!trimmed || !service || pending) return;
    // A retry resends a message already counted.
    if (base === messages) {
      if (!base.some((m) => m.role === "user")) trackPlanEvent("plan_first_message");
      trackPlanEvent("plan_message");
    }
    setFailed(null);
    const history: WillChatMessage[] = [...base.map((m) => ({ role: m.role, text: textOf(m) })), { role: "user", text: trimmed }];
    setMessages([...base.map((x) => ({ ...x, fresh: false })), { id: ++id.current, role: "user", text: trimmed }]);
    setPending(true);
    try {
      const res = await service.willChat(history, locale);
      setMessages((m) => [...m, { id: ++id.current, role: "agent", text: res.reply, fresh: true }]);
      if (res.draft) setDraft(res.draft);
    } catch {
      setFailed(trimmed);
    } finally {
      setPending(false);
    }
  };

  const sign = async () => {
    if (!draft) return;
    const signed = isMock ? draft : withWallets(draft, wallets);
    setPayeeRefused(false);
    const res = await run("sign", (s) => s.createEstateFromWill(signed, { practice, residualLabel: residualLabel || draft.beneficiaries[0]?.label }));
    if (res.ok) { trackPlanEvent("plan_signed"); onSigned(res.value); }
    else if (res.code === "recurring_payee") setPayeeRefused(true);
  };

  if (view === "review" && draft) {
    const missing = isMock ? [] : missingPeople(draft, wallets);
    const trusted = checkTrusted(isMock ? draft : withWallets(draft, wallets), session.address);
    const known = isMock ? DEMO_PAYEES : [];
    const noPayee = missingPayees(draft.rules, known, practice);
    const made = practice ? [...new Set(missingPayees(draft.rules, known).map((m) => m.name))] : [];
    const secsNow = scheduleSecs("month", isMock ? "mock" : "chain");
    const everyWords = clockOf(secsNow, "month").fast
      ? Object.fromEntries(Object.keys(copy.preview.every).map((k) => [k, fmt(copy.preview.secondsHere, { secs: secsNow })])) as Record<keyof typeof copy.preview.every, string>
      : copy.preview.every;
    return (
      <Review
        copy={copy} draft={draft} edited={owned?.edited ?? false} onBack={() => setView("chat")} onSign={sign} signing={busy === "sign"}
        blocked={missing.length > 0 || !!trusted.problem || noPayee.length > 0}
        setup={(
          <>
            <SetupChecks
              draft={draft} every={everyWords} trusted={trusted} missing={noPayee} made={made} refused={payeeRefused}
              onFixPeople={() => setView("chat")}
              onFixWallets={isMock ? undefined : () => { setWallets({}); setPractice(false); setAddressRound((n) => n + 1); }}
              onPractice={() => { setPractice(true); setPayeeRefused(false); }}
              onRequest={(index) => {
                const r = [...(rawDraft?.rules ?? []), ...extra][index];
                if (r) setOnRequest((x) => [...x, scheduleKey(r)]);
                setPayeeRefused(false);
              }}
            />
            <NamesNotice className="mt-4" />
            <ResidualPicker draft={draft} value={residualLabel || draft.beneficiaries[0]?.label || ""} onChange={setResidualLabel} />
            {!isMock && (
              <ConnectPeople key={addressRound} draft={draft} missing={missing} wallets={wallets} onWallets={(next, made) => { setWallets(next); if (made) setPractice(true); }} />
            )}
          </>
        )}
      />
    );
  }

  const chips = turns < copy.suggestions.length ? copy.suggestions[turns] : copy.suggestions[copy.suggestions.length - 1];
  return (
    <>
      <PageHeader
        eyebrow={copy.eyebrow} title={copy.title} body={copy.body}
        action={<Button variant="secondary" small onClick={() => openAgent("call")}><Phone className="size-4" aria-hidden="true" />{copy.talk}</Button>}
      />
      <NamesNotice className="mb-4" />
      {/* Two aligned cards of equal height; each scrolls inside itself so chatting never pushes the page down. */}
      <div className="grid gap-5 *:min-w-0 lg:h-[max(32rem,calc(100dvh-var(--header-h)-15rem))] lg:grid-cols-[1.2fr_1fr] lg:items-stretch">
        <section aria-label={copy.eyebrow} className="flex h-[min(42rem,72dvh)] min-h-0 min-w-0 flex-col rounded-xl border border-line bg-surface shadow-card lg:h-full">
          <div ref={log} tabIndex={0} aria-label={copy.eyebrow} className="relative min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus)] sm:p-4">
            <div role="log" aria-live="polite" aria-relevant="additions">
              <ul className="flex flex-col gap-4">
                {messages.map((m) => (
                  <Bubble key={m.id} role={m.role} text={textOf(m)} fresh={m.fresh} enter={m.id === 0 ? greetingEnter : "motion"} specialist={m.role === "agent" ? "WillWriter" : undefined} copy={assistant} onTick={scroll} onTyped={scroll} />
                ))}
                {pending && <Thinking label={copy.thinking} />}
              </ul>
            </div>
            {failed && (
              <Notice tone="danger" className="mt-3">
                <p role="alert">{copy.error}</p>
                <Button small variant="secondary" className="mt-2" onClick={() => void send(failed, messages.slice(0, -1))}>{copy.retry}</Button>
              </Notice>
            )}
            <div ref={end} className="h-1" />
          </div>

          <div className="shrink-0 border-t border-line p-3 sm:p-4">
            {!consent && turns === 0 ? (
              <div>
                <p className="mb-1.5 text-small font-semibold">{copy.consentLead}</p>
                <Consent id="will-consent" checked={consent} onChange={setConsent} copy={common.consent} />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {!pending && !failed && variant !== "blank" && <Chips items={chips} onPick={(s) => (s === copy.suggestions[copy.suggestions.length - 1]?.[1] && complete ? setView("review") : void send(s))} label={copy.suggestionsLabel} />}
                <Composer onSend={send} disabled={pending} copy={copy.composer} />
              </div>
            )}
          </div>
        </section>

        <div className="flex max-h-[min(42rem,80dvh)] min-h-0 flex-col lg:h-full lg:max-h-none">
          <Preview
            copy={copy} draft={draft} onStart={(i, now) => { const r = [...(rawDraft?.rules ?? []), ...extra][i]; if (r) setStarts((prev) => ({ ...prev, [ruleKey(r)]: now })); }}
            bills={bills} extraFrom={rawDraft?.rules.length ?? 0} onAddBill={addBill}
            onRemoveBill={(i) => setExtra((x) => x.filter((_, j) => j !== i))}
            footer={complete && (
              <div className="enter mt-3 shrink-0 border-t border-line pt-3 [--from-y:10px]">
                <Button block onClick={() => setView("review")}><PenLine className="size-5" aria-hidden="true" />{copy.reviewCta}</Button>
              </div>
            )}
          />
        </div>
      </div>
    </>
  );
}

/* ---------- Live rules preview ---------- */

function Slot({ icon, title, filled, pending, children }: { icon: ReactNode; title: string; filled: boolean; pending: string; children: ReactNode }) {
  return (
    <div className={clsx("rounded-md border p-3 transition-colors duration-500", filled ? "border-line bg-surface" : "border-dashed border-line-strong/60 bg-transparent")}>
      <p className="flex items-center gap-2 text-small font-semibold">
        <span className={clsx("grid size-7 place-items-center rounded-full", filled ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2")}>{filled ? <Check className="size-4" aria-hidden="true" /> : icon}</span>
        {title}
      </p>
      <div className="mt-2 text-small">{filled ? children : <span className="text-ink-2">{pending}</span>}</div>
    </div>
  );
}

function Preview({ copy, draft, onStart, footer, bills, extraFrom, onAddBill, onRemoveBill }: {
  copy: Copy; draft: WillDraft | null; onStart: (index: number, now: boolean) => void; footer?: ReactNode;
  bills: BillsCopy; extraFrom: number; onAddBill: (rule: WillDraft["rules"][number]) => void; onRemoveBill: (index: number) => void;
}) {
  const { common } = useCopy();
  const p = copy.preview;
  const waitText = useWaitPeriod(copy);
  const clock = useScheduleClock();
  const parts = [!!draft?.beneficiaries.length, !!draft?.rules.length, (draft?.verifiers.length ?? 0) >= 3, !!draft?.assets.length];
  const done = parts.filter(Boolean).length;
  return (
    <Card aria-label={p.title} className="flex min-h-0 flex-1 flex-col bg-surface-2/50">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3">{p.title}</h2>
        <Badge tone={done === 4 ? "ok" : "accent"}><Sparkles className="size-3.5" aria-hidden="true" />{done === 4 ? p.ready : p.live}</Badge>
      </div>
      <p className="mt-1 shrink-0 text-small text-ink-2" role="status" aria-live="polite">{draft ? fmt(p.progress, { done }) : p.emptyHint}</p>
      <div tabIndex={0} aria-label={p.title} className="relative -mr-2 mt-3 grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto pr-2 [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]">
        <Slot icon={<UsersRound className="size-4" aria-hidden="true" />} title={p.family} filled={parts[0]} pending={p.pending}>
          <ul className="flex flex-wrap gap-1.5">
            {draft?.beneficiaries.map((b) => (
              <li key={b.label} className="enter [--from-x:-8px] [--from-y:0] rounded-full border border-ink px-2.5 py-1 font-medium text-ink">{b.label.split(" ")[0]} · {b.relationship}</li>
            ))}
          </ul>
        </Slot>
        <Slot icon={<GraduationCap className="size-4" aria-hidden="true" />} title={p.rules} filled={parts[1]} pending={p.pending}>
          <p className="mb-2 text-[0.75rem] text-ink-2">{p.startHint}</p>
          <ul className="flex flex-col gap-2">
            {draft?.rules.map((r, i) => {
              const Icon = categoryIcon[r.category];
              const cat = common.status.category[r.category];
              return (
                <li key={`${r.beneficiaryLabel}-${r.category}-${i}`} style={{ "--enter-delay": `${i * 0.08}s` } as CSSProperties} className="enter [--from-x:-8px] [--from-y:0] rounded-md border border-line bg-surface-2/50 p-2.5">
                  <div className="flex items-start gap-2">
                    <Icon className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p><span className="font-semibold">{r.beneficiaryLabel}</span> · {cat}</p>
                      <p className="text-ink-2">
                        {r.recurring
                          ? fmt(clock(r.recurring.every).fast ? p.recurringLineFast : p.recurringLine, { amount: usd(r.recurring.amountUsdt), every: p.every[r.recurring.every], payee: r.recurring.payeeName })
                          : fmt(p.ruleLine, { category: p.onClaim, max: usd(r.maxPerClaimUsdt), cap: usd(r.lifetimeCapUsdt) })}
                      </p>
                      {r.recurring && clockText(clock(r.recurring.every), p) && <p className="text-[0.75rem] font-semibold">{clockText(clock(r.recurring.every), p)}</p>}
                    </div>
                    {r.recurring && <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-ink px-2 py-0.5 text-[0.7rem] font-semibold text-ink"><CalendarClock className="size-3" aria-hidden="true" />{p.scheduled}</span>}
                  </div>
                  {i >= extraFrom && (
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2">
                      <span className="text-[0.75rem] font-semibold text-ink-2">{bills.form.fromTemplate}</span>
                      <button type="button" onClick={() => onRemoveBill(i - extraFrom)} className="inline-flex min-h-9 items-center gap-1 rounded-full px-1 text-[0.75rem] font-semibold text-ink underline underline-offset-4 hover:decoration-2">
                        <X className="size-3.5" aria-hidden="true" />{fmt(bills.form.remove, { name: cat.toLowerCase() })}
                      </button>
                    </div>
                  )}
                  <fieldset className="mt-2">
                    <legend className="sr-only">{fmt(p.startLabel, { category: cat.toLowerCase(), name: r.beneficiaryLabel })}</legend>
                    <div className="flex rounded-full bg-surface p-0.5 ring-1 ring-line-strong">
                      {[true, false].map((now) => (
                        <label key={String(now)} className={clsx("flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2 text-[0.8rem] font-semibold transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]", r.startsNow === now ? (now ? "bg-accent text-accent-ink" : "bg-ink text-bg") : "text-ink-2")}>
                          <input type="radio" name={`start-${i}`} className="sr-only" checked={r.startsNow === now} onChange={() => onStart(i, now)} />
                          {now ? <Zap className="size-3.5" aria-hidden="true" /> : <Hourglass className="size-3.5" aria-hidden="true" />}
                          {now ? p.now : p.later}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </li>
              );
            })}
          </ul>
        </Slot>
        <section aria-label={bills.title} className="rounded-md border border-dashed border-line-strong/60 p-3">
          <p className="text-small font-semibold">{bills.title}</p>
          <p className="mb-2 mt-0.5 text-[0.75rem] text-ink-2">{draft?.beneficiaries.length ? bills.body : bills.needFamily}</p>
          <BillTemplates
            compact copy={bills} disabled={!draft?.beneficiaries.length}
            target={{ mode: "draft", beneficiaries: (draft?.beneficiaries ?? []).map((b) => ({ value: b.label, label: `${b.label.split(" ")[0]} · ${b.relationship}` })), onAdd: onAddBill }}
          />
        </section>
        <Slot icon={<ShieldCheck className="size-4" aria-hidden="true" />} title={p.trusted} filled={parts[2]} pending={p.pending}>
          <ul className="flex flex-col gap-1">
            {draft?.verifiers.map((v, i) => (
              <li key={v.name} style={{ "--enter-delay": `${i * 0.08}s` } as CSSProperties} className="enter [--from-x:-8px] [--from-y:0]"><span className="font-semibold">{v.name}</span> · <span className="text-ink-2">{v.role}</span></li>
            ))}
          </ul>
        </Slot>
        <Slot icon={<CarFront className="size-4" aria-hidden="true" />} title={p.car} filled={parts[3]} pending={p.pending}>
          {draft?.assets.map((a) => (
            <div key={a.title} className="enter [--from-x:-8px] [--from-y:0]">
              <p className="font-semibold">{a.title}</p>
              <p>{fmt(p.carFloor, { floor: usd(a.floorPriceUsdt) })} · {fmt(p.carHardship, { floor: usd(a.hardshipFloorUsdt) })}</p>
            </div>
          ))}
        </Slot>
        {draft && (
          <p className="flex items-center gap-2 px-1 text-small text-ink-2"><Clock className="size-4 shrink-0" aria-hidden="true" />{p.waiting}: {fmt(p.waitingValue, { period: waitText(draft.waitingPeriodDays) })}</p>
        )}
      </div>
      {footer}
    </Card>
  );
}

/* ---------- Plain-language review ---------- */

function Review({ copy, draft, edited, onBack, onSign, signing, blocked, setup }: { copy: Copy; draft: WillDraft; edited: boolean; onBack: () => void; onSign: () => void; signing: boolean; blocked: boolean; setup: ReactNode }) {
  const { common } = useCopy();
  const r = copy.review;
  const need = 2;
  const waitText = useWaitPeriod(copy);
  const clock = useScheduleClock();
  return (
    <div className="enter mx-auto max-w-2xl [--enter-dur:0.3s] [--from-y:12px]">
      <button type="button" onClick={onBack} className="mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3 text-small font-semibold text-accent"><ArrowLeft className="size-4" aria-hidden="true" />{r.back}</button>
      <Eyebrow>{r.eyebrow}</Eyebrow>
      <h1 className="mt-1.5 text-h1">{r.title}</h1>

      <Card className="mt-5">
        <h2 className="text-h3">{r.summaryTitle}</h2>
        <p className="mt-2 text-lead">{draft.plainLanguageSummary}</p>
        {edited && <p className="mt-2 text-small text-ink-2">{r.summaryEdited}</p>}
      </Card>

      {([true, false] as const).map((now) => {
        const group = draft.rules.filter((rule) => rule.startsNow === now);
        return (
          <section key={String(now)} className="mt-6">
            <h2 className="flex items-center gap-2 text-h3">
              {now ? <Zap className="size-5 text-amber" aria-hidden="true" /> : <Hourglass className="size-5 text-amber-ink" aria-hidden="true" />}
              {now ? r.nowTitle : r.laterTitle}
            </h2>
            <p className="mt-1 text-small text-ink-2">{now ? (group.length ? r.nowBody : r.noneNow) : r.laterBody}</p>
            <ol className="mt-3 grid gap-2.5">
              {group.map((rule, i) => {
                const Icon = categoryIcon[rule.category];
                const base = {
                  name: rule.beneficiaryLabel, category: common.status.category[rule.category].toLowerCase(), kind: common.status.payeeKind[rule.allowedPayeeKind].toLowerCase(),
                  max: usd(rule.maxPerClaimUsdt), cap: usd(rule.lifetimeCapUsdt), date: longDate(rule.validUntil),
                };
                return (
                  <li key={i} className="flex gap-3 rounded-md border border-line bg-surface p-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-amber"><Icon className="size-5" aria-hidden="true" /></span>
                    <div className="min-w-0">
                      <p>{rule.recurring
                        ? fmt(clock(rule.recurring.every).fast ? r.recurringRuleFast : r.recurringRule, { ...base, amount: usd(rule.recurring.amountUsdt), payee: rule.recurring.payeeName, every: copy.preview.every[rule.recurring.every] })
                        : fmt(rule.allowedPayeeKind === "Other" ? r.ruleOther : r.rule, base)}</p>
                      {rule.recurring && clockText(clock(rule.recurring.every), copy.preview) && <p className="mt-1 text-small font-semibold">{clockText(clock(rule.recurring.every), copy.preview)}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}

      <section className="mt-6">
        <h2 className="text-h3">{r.trustedTitle}</h2>
        <p className="mt-2 text-ink-2">{fmt(r.trusted, { need, period: waitText(draft.waitingPeriodDays) })}</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {draft.verifiers.map((v) => (
            <li key={v.name} className="rounded-md border border-line bg-surface p-3">
              <p className="font-semibold">{v.name}</p>
              <p className="text-small text-ink-2">{v.role}</p>
            </li>
          ))}
        </ul>
      </section>

      {draft.assets.map((a) => (
        <section key={a.title} className="mt-6">
          <h2 className="text-h3">{r.carTitle}</h2>
          <p className="mt-2">{fmt(r.car, { title: a.title, floor: usd(a.floorPriceUsdt), proceeds: a.proceedsTo })}</p>
          <p className="mt-2 text-ink-2">{fmt(r.carHardship, { policy: a.hardshipPolicy, floor: usd(a.hardshipFloorUsdt) })}</p>
          <p className="mt-2 text-small font-semibold">{r.carNotRegistered}</p>
        </section>
      ))}

      {setup}

      <section className="mt-6">
        <h2 className="text-h3">{r.limitsTitle}</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-2 marker:text-amber">
          {r.limits.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </section>

      <div className="sticky bottom-[var(--safe-b)] -mx-4 mt-6 border-t border-line bg-bg px-4 py-3 lg:bottom-0">
        <Button block onClick={onSign} disabled={blocked} loading={signing} className="min-h-13!">
          <Lock className="size-5" aria-hidden="true" />{signing ? r.signing : r.sign}
        </Button>
        <p className="mt-2 text-center text-small text-ink-2">{r.signNote}</p>
      </div>
    </div>
  );
}

/* ---------- After signing: the will as it stands on-chain ---------- */

function Locked({ copy, bills, snap }: { copy: Copy; bills: BillsCopy; snap: EstateSnapshot }) {
  const { common } = useCopy();
  const { openAgent } = useEstate();
  const nameOf = useWho(snap);
  const l = copy.locked;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={copy.eyebrow} title={l.title} body={l.body} />
      <ol className="grid gap-2.5">
        {snap.rules.map((rule) => {
          const Icon = categoryIcon[rule.category];
          const who = snap.beneficiaries.find((b) => b.wallet === rule.beneficiary)?.label ?? nameOf(rule.beneficiary);
          const base = {
            name: who, category: common.status.category[rule.category].toLowerCase(), kind: common.status.payeeKind[rule.allowedPayeeKind].toLowerCase(),
            max: formatUsdt(rule.maxPerClaim, { decimals: 0 }), cap: formatUsdt(rule.lifetimeCap, { decimals: 0 }), date: longDate(rule.validUntil),
          };
          const recurring = rule.recurringAmount > BigInt(0);
          return (
            <li key={rule.address} className="flex gap-3 rounded-md border border-line bg-surface p-3.5 shadow-card">
              <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-amber"><Icon className="size-5" aria-hidden="true" /></span>
              <div className="min-w-0">
                <Badge tone={rule.startsNow ? "gold" : "neutral"}>{rule.startsNow ? <Zap className="size-3.5" aria-hidden="true" /> : <Hourglass className="size-3.5" aria-hidden="true" />}{rule.startsNow ? copy.preview.now : copy.preview.later}</Badge>
                <p className="mt-1.5">{recurring
                  ? fmt(ruleClock(rule).fast ? copy.review.recurringRuleFast : copy.review.recurringRule, { ...base, amount: formatUsdt(rule.recurringAmount, { decimals: 0 }), payee: nameOf(rule.fixedPayee), every: copy.preview.every[signedEvery(rule)] })
                  : fmt(rule.allowedPayeeKind === "Other" ? copy.review.ruleOther : copy.review.rule, base)}</p>
                {recurring && clockText(ruleClock(rule), copy.preview) && <p className="mt-1 text-small font-semibold">{clockText(ruleClock(rule), copy.preview)}</p>}
                <EndRule snap={snap} rule={rule} />
              </div>
            </li>
          );
        })}
      </ol>
      {snap.estate.willHash && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-small text-ink-2"><Lock className="size-4" aria-hidden="true" />{l.fingerprint}: <span className="font-mono text-ink">{shortAddress(snap.estate.willHash, 10)}</span></p>
      )}
      {snap.estate.status === "Active" && (
        <section aria-labelledby="bills-title" className="mt-6">
          <h2 id="bills-title" className="text-h3">{bills.signedTitle}</h2>
          <p className="mb-3 mt-1 text-small text-ink-2">{bills.signedBody}</p>
          <BillTemplates
            copy={bills}
            target={{
              mode: "signed",
              beneficiaries: snap.beneficiaries.filter((b) => b.active).map((b) => ({ value: b.wallet, label: b.label })),
              payees: snap.payees.map((x) => ({ value: x.wallet, label: x.name, kind: x.kind })),
              // The estate's value for the executor's cap: the vault plus each unsold asset's minimum price.
              estateUsdt: fromBase(snap.estate.vaultBalance) + snap.assets.filter((a) => a.status !== "Sold").reduce((n, a) => n + fromBase(a.floorPrice), 0),
            }}
          />
        </section>
      )}
      <GuardiansPlanLink />
      <FallbackPlanCard snap={snap} className="mt-5" />
      <WillLettersCard className="mt-5" />
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <ButtonLink href="/estate">{l.estate}<ArrowRight className="size-5" aria-hidden="true" /></ButtonLink>
        <Button variant="secondary" onClick={() => openAgent("chat")}>{l.ask}</Button>
      </div>
    </div>
  );
}
