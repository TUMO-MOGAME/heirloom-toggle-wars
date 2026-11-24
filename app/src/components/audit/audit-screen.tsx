"use client";
/**
 * The public record of an estate (/audit/<estate address>): read-only, no wallet, no PIN. A family member or the
 * executor can open it from a shared link. It reads the same snapshot the app does, drops the agent's document
 * reports and guardian details (lib/audit.ts publicSnapshot), and shows documents only as SHA-256 fingerprints.
 * Receipts reuse the Proof drawer's pieces (ActivityList, CopyValue, ExplorerLink): simulated in demo mode.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { MotionScope } from "@/components/ui/motion-provider";
import { CloudOff, FileCheck2, Info, Landmark, ScrollText, UsersRound } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import type { CommonCopy } from "@/content/common";
import type { AssistantCopy } from "@/content/assistant";
import type { PayCopy } from "@/content/pay";
import type { DisputesCopy } from "@/content/disputes";
import type { GuardiansCopy } from "@/content/guardians";
import { useLocalized } from "@/lib/i18n/client";
import { getService, type EstateSnapshot, type HeirloomService } from "@/lib/service";
import { DEMO_STAGES, isMockService, type DemoStage } from "@/lib/service/mock";
import { auditDecisions, auditPayments, isMissingEstate, looksLikeAddress, publicSnapshot } from "@/lib/audit";
import { checkInPlan } from "@/lib/checkin";
import { eligibleSeats } from "@/lib/death-rules";
import { claimTally, deathTally, hardshipTally, isHeld } from "@/lib/guardians/decisions";
import { formatUsdt } from "@/lib/format";
import { useNow } from "@/lib/hooks/use-now";
import type { Claim, EstateStatus } from "@/lib/types";
import { Badge, Button, ButtonLink, Card, DefList, EmptyState, ExplorerLink, LoadingCards, Notice, type Tone } from "@/components/ui/primitives";
import { CopyProvider, fmt, useCopy } from "@/components/shell/copy";
import { ActivityList, CopyValue } from "@/components/shell/proof-drawer";
import { usePublicNameBook } from "@/components/shell/activity-text";
import { Marked } from "@/components/ui/marked";

type Copy = ScreensCopy["audit"];
const PROGRAM_ID = process.env.NEXT_PUBLIC_HEIRLOOM_PROGRAM_ID ?? "";
const longDate = (secs: number) => new Date(secs * 1000).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });
/** Same tones as the estate screen's status badge. */
const statusTone: Record<EstateStatus, Tone> = { Active: "accent", DeathPending: "warn", Unlocked: "ok", Frozen: "danger" };

export interface AuditShellCopy { common: CommonCopy; assistant: AssistantCopy; pay: PayCopy; guardians: GuardiansCopy; disputes: DisputesCopy; siteName: string }

/** Copy for the shared pieces (receipts, status names), localized like the app shell, without the wallet or PIN gate. */
export function AuditScreen({ address, copy: english, shell }: { address: string; copy: Copy; shell: AuditShellCopy }) {
  const common = useLocalized(shell.common, (t) => t.common);
  const assistant = useLocalized(shell.assistant, (t) => t.assistant);
  const pay = useLocalized(shell.pay, (t) => t.pay);
  const guardians = useLocalized(shell.guardians, (t) => t.guardians);
  const disputes = useLocalized(shell.disputes, (t) => t.disputes);
  const copy = useLocalized(english, (t) => t.screens.audit);
  return (
    <CopyProvider value={{ common, assistant, pay, guardians, disputes, siteName: shell.siteName }}>
      <MotionScope>
        <AuditBody address={address} copy={copy} />
      </MotionScope>
    </CopyProvider>
  );
}

type Load = { phase: "loading" } | { phase: "missing" } | { phase: "error" } | { phase: "ready"; snap: EstateSnapshot };

function AuditBody({ address, copy }: { address: string; copy: Copy }) {
  const [service, setService] = useState<HeirloomService | null>(null);
  const [state, setState] = useState<Load>({ phase: "loading" });

  const load = useCallback(async (svc: HeirloomService) => {
    if (!looksLikeAddress(address)) { setState({ phase: "missing" }); return; }
    try {
      const snap = await svc.getEstate(address);
      // The demo holds one estate (in this browser): any other address is not found.
      if (snap.estate.address !== address) { setState({ phase: "missing" }); return; }
      setState({ phase: "ready", snap: publicSnapshot(snap) });
    } catch (e) {
      setState(isMissingEstate(e) ? { phase: "missing" } : { phase: "error" });
    }
  }, [address]);

  useEffect(() => {
    let alive = true;
    void getService().then((svc) => {
      if (!alive) return;
      // Demo links: "?demo=<stage>" resets the simulated estate once, as in the app.
      if (isMockService(svc)) {
        const url = new URL(window.location.href);
        const stage = url.searchParams.get("demo");
        if (stage && (DEMO_STAGES as readonly string[]).includes(stage)) {
          svc.resetDemo(stage as DemoStage);
          url.searchParams.delete("demo");
          window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
        }
      }
      setService(svc);
      void load(svc);
    });
    return () => { alive = false; };
  }, [load]);

  // The page keeps its heading while the record loads from the chain (devnet can take several seconds).
  if (state.phase === "loading") return (
    <>
      <p className="eyebrow">{copy.eyebrow}</p>
      <h1 className="mt-1 mb-4 text-h2">{copy.metaTitle}</h1>
      <LoadingCards label={copy.loading} />
    </>
  );
  if (state.phase === "missing") {
    return <EmptyState level={1} icon={<ScrollText className="size-6" aria-hidden="true" />} title={copy.notFound.title} body={copy.notFound.body} action={<ButtonLink href="/" variant="secondary">{copy.openApp}</ButtonLink>} />;
  }
  if (state.phase === "error") {
    return <EmptyState level={1} icon={<CloudOff className="size-6" aria-hidden="true" />} title={copy.error.title} body={copy.error.body} action={<Button onClick={() => { if (service) { setState({ phase: "loading" }); void load(service); } }}>{copy.error.retry}</Button>} />;
  }
  return <Record copy={copy} snap={state.snap} isMock={service?.mode === "mock"} />;
}

function Section({ id, title, body, icon, children }: { id: string; title: string; body?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Card role="region" aria-labelledby={id}>
      <h2 id={id} className="flex items-center gap-2 text-h3">{icon}{title}</h2>
      {body && <p className="mt-1 text-small text-ink-2">{body}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function Fingerprint({ label, value }: { label: string; value: string | null }) {
  const { common } = useCopy();
  if (!value) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[0.75rem] text-ink-2">
      <span>{label}:</span>
      <CopyValue value={value} copyLabel={common.proof.copy} copiedLabel={common.proof.copied} />
    </p>
  );
}

function Record({ copy, snap, isMock }: { copy: Copy; snap: EstateSnapshot; isMock: boolean }) {
  const { common } = useCopy();
  const now = useNow(30000);
  const book = usePublicNameBook(snap);
  const e = snap.estate;
  const plan = checkInPlan(isMock ? "mock" : "chain");
  const { guardians } = useCopy();
  const living = eligibleSeats(e.verifiers).length;
  const quorumText = (threshold: number) => (living ? fmt(copy.rules.quorum, { need: Math.min(threshold, living), total: living }) : guardians.rules.tally.nobody);
  // Once the wait has started the confirmations are history; until then only those that count.
  const confirmations = () => (e.status === "Active" ? deathTally(e).got : e.death.attestations.filter(Boolean).length);
  const payeeName = (wallet: string) => snap.payees.find((p) => p.wallet === wallet)?.name ?? wallet.slice(0, 4) + "…" + wallet.slice(-4);
  const who = (wallet: string) => snap.beneficiaries.find((b) => b.wallet === wallet)?.label ?? wallet.slice(0, 4) + "…" + wallet.slice(-4);
  const ruleOf = (c: Claim) => snap.rules.find((r) => r.address === c.rule);
  const payments = auditPayments(snap);
  const decisions = auditDecisions(snap);
  const facts = [
    ...(PROGRAM_ID ? [{ term: common.proof.facts.program, value: PROGRAM_ID }] : []),
    { term: common.proof.facts.estate, value: e.address },
    { term: common.proof.facts.will, value: e.willHash },
    { term: common.proof.facts.mint, value: e.usdtMint },
    { term: common.proof.facts.agent, value: e.agent },
  ];

  return (
    <div className="grid gap-5 *:min-w-0">
      <header className="min-w-0 max-w-3xl">
        <p className="text-small font-semibold uppercase tracking-[0.14em] text-ink">{copy.eyebrow}</p>
        <h1 className="mt-1 text-h2"><Marked text={fmt(copy.title, { name: e.ownerName })} /></h1>
        <p className="mt-2 text-ink-2">{copy.body}</p>
      </header>
      {isMock && <Notice tone="warn" icon={<Info className="size-5" aria-hidden="true" />}>{copy.demoNote}</Notice>}

      <div className="grid gap-5 *:min-w-0 lg:grid-cols-2 lg:items-start">
        <Section id="audit-status" title={copy.status.title} icon={<Landmark className="size-5 text-amber" aria-hidden="true" />}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone[e.status]}>{common.status.estate[e.status]}</Badge>
            <span className="text-small text-ink-2">{common.status.estateHint[e.status]}</span>
          </div>
          <DefList className="mt-3" items={[
            { term: copy.status.vault, value: <span className="tabular-nums">{formatUsdt(e.vaultBalance)}</span> },
            { term: copy.status.lastCheckIn, value: e.lastHeartbeat > 0 ? longDate(e.lastHeartbeat) : common.time.never },
            { term: copy.status.waiting, value: fmt(copy.status.days, { n: Math.round(e.waitingPeriodSecs / plan.secsPerDay) }) },
          ]} />
        </Section>

        <Section id="audit-people" title={copy.rules.who} icon={<UsersRound className="size-5 text-amber" aria-hidden="true" />}>
          <DefList items={[
            { term: copy.rules.death, value: quorumText(e.deathThreshold) },
            { term: copy.rules.claims, value: quorumText(e.claimThreshold) },
            { term: copy.rules.hardship, value: quorumText(e.hardshipThreshold) },
          ]} />
          <h3 className="mt-4 font-sans text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.rules.people}</h3>
          <ul className="mt-1 flex flex-col gap-1 text-small font-medium">
            {e.verifierNames.map((n, i) => <li key={i}>{isHeld(e.verifiers[i]) ? n : guardians.vacant}</li>)}
          </ul>
        </Section>
      </div>

      <Section id="audit-rules" title={copy.rules.title} body={copy.rules.body} icon={<ScrollText className="size-5 text-amber" aria-hidden="true" />}>
        {snap.rules.length === 0 ? <p className="text-ink-2">{copy.rules.empty}</p> : (
          <ul className="grid gap-3 *:min-w-0 sm:grid-cols-2">
            {snap.rules.map((r) => (
              <li key={r.address} className="rounded-md border border-line-strong p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 font-semibold">{who(r.beneficiary)} · {common.status.category[r.category]}</p>
                  <Badge tone={r.startsNow ? "gold" : "neutral"}>{r.startsNow ? copy.rules.now : copy.rules.after}</Badge>
                </div>
                <p className="mt-1 text-small text-ink-2">{fmt(copy.rules.perClaim, { amount: formatUsdt(r.maxPerClaim, { decimals: 0 }) })}</p>
                <p className="text-small text-ink-2 tabular-nums">{fmt(copy.rules.used, { spent: formatUsdt(r.spentTotal, { decimals: 0 }), cap: formatUsdt(r.lifetimeCap, { decimals: 0 }) })}</p>
                {r.recurringAmount > BigInt(0) && r.fixedPayee && <p className="text-small text-ink-2">{fmt(copy.rules.every, { amount: formatUsdt(r.recurringAmount, { decimals: 0 }), payee: payeeName(r.fixedPayee) })}</p>}
                <p className="text-[0.75rem] text-ink-2">{fmt(copy.rules.until, { date: longDate(r.validUntil) })}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="audit-payments" title={copy.payments.title} body={copy.payments.body} icon={<FileCheck2 className="size-5 text-amber" aria-hidden="true" />}>
        {payments.length === 0 ? <p className="text-ink-2">{copy.payments.empty}</p> : <ActivityList items={payments} now={now} book={book} receipts={{ estate: snap.estate.address, rules: snap.rules, assets: snap.assets }} />}
      </Section>

      <Section id="audit-decisions" title={copy.decisions.title} body={copy.decisions.body} icon={<UsersRound className="size-5 text-amber" aria-hidden="true" />}>
        <h3 className="font-sans text-body font-semibold tracking-normal">{copy.decisions.passing}</h3>
        {e.death.certHash ? (
          <>
            <p className="mt-1 text-small">{fmt(copy.decisions.reported, { verdict: copy.decisions.verdict[e.death.verdict], got: confirmations(), need: deathTally(e).needed })}</p>
            <Fingerprint label={copy.decisions.certificate} value={e.death.certHash} />
          </>
        ) : <p className="mt-1 text-small text-ink-2">{copy.decisions.noPassing}</p>}

        {snap.claims.length > 0 && (
          <ul className="mt-4 flex flex-col border-t border-line">
            {snap.claims.map((c) => (
              <li key={c.address} className="border-b border-line py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 text-small font-medium">{fmt(copy.decisions.claim, { amount: formatUsdt(c.amount, { decimals: 0 }), payee: payeeName(c.payee), category: common.status.category[ruleOf(c)?.category ?? "General"] })}</p>
                  <Badge tone={c.status === "Paid" ? "ok" : c.status === "Rejected" ? "danger" : "warn"}>{common.status.claim[c.status]}</Badge>
                </div>
                <p className="text-[0.75rem] text-ink-2">{c.ownerApproved ? copy.decisions.ownerApproved : fmt(copy.decisions.approvals, { got: claimTally(e, c).got, need: claimTally(e, c).needed })}</p>
                <Fingerprint label={copy.decisions.evidence} value={c.evidenceHash} />
                {c.txSignature && <ExplorerLink signature={c.txSignature} label={copy.receipt} srLabel={copy.receiptSr} />}
              </li>
            ))}
          </ul>
        )}

        {snap.hardships.length > 0 && (
          <ul className="mt-4 flex flex-col border-t border-line">
            {snap.hardships.map((h) => (
              <li key={h.address} className="border-b border-line py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 text-small font-medium">{fmt(copy.decisions.hardship, { asset: snap.assets.find((a) => a.address === h.asset)?.title ?? "" })}</p>
                  <Badge tone={h.status === "Approved" ? "ok" : h.status === "Rejected" ? "danger" : "warn"}>{common.status.hardship[h.status]}</Badge>
                </div>
                <p className="text-[0.75rem] text-ink-2">{fmt(copy.decisions.approvals, { got: hardshipTally(e, h).got, need: hardshipTally(e, h).needed })}</p>
                <Fingerprint label={copy.decisions.evidence} value={h.evidenceHash} />
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-5 font-sans text-body font-semibold tracking-normal">{copy.decisions.steps}</h3>
        {decisions.length === 0 ? <p className="mt-1 text-small text-ink-2">{copy.decisions.none}</p> : <ActivityList items={decisions} now={now} book={book} />}
      </Section>

      <div className="grid gap-5 *:min-w-0 lg:grid-cols-2 lg:items-start">
        <Section id="audit-assets" title={copy.assets.title}>
          {snap.assets.length === 0 ? <p className="text-ink-2">{copy.assets.empty}</p> : (
            <ul className="flex flex-col gap-3">
              {snap.assets.map((a) => (
                <li key={a.address} className="rounded-md border border-line-strong p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 font-semibold">{a.title}</p>
                    <Badge tone={a.status === "Sold" ? "ok" : a.status === "Listed" ? "warn" : "neutral"}>{common.status.asset[a.status]}</Badge>
                  </div>
                  <p className="text-small text-ink-2">{copy.assets.floor}: {formatUsdt(a.floorPrice, { decimals: 0 })}</p>
                  <Fingerprint label={copy.assets.doc} value={a.docHash} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="audit-facts" title={copy.facts.title}>
          <dl className="rounded-lg border border-line bg-surface px-3.5 py-1">
            {facts.map((f) => (
              <div key={f.term} className="flex flex-wrap items-center justify-between gap-x-3 border-b border-line py-1 last:border-0">
                <dt className="text-small text-ink-2">{f.term}</dt>
                <dd className="min-w-0">{f.value ? <CopyValue value={f.value} copyLabel={common.proof.copy} copiedLabel={common.proof.copied} /> : <span className="text-small">{common.proof.notSigned}</span>}</dd>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-x-3 py-2.5">
              <dt className="text-small text-ink-2">{common.proof.facts.network}</dt>
              <dd className="text-small font-medium">{common.proof.network}</dd>
            </div>
          </dl>
        </Section>
      </div>

      <p className="text-small text-ink-2">{copy.footer}</p>
    </div>
  );
}
