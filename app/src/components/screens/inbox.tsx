"use client";
import { useState, type ReactNode } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import { Banknote, Check, FileHeart, HandHeart, Inbox as InboxIcon, ScanSearch, Undo2 } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot } from "@/lib/service";
import type { AgentReport, Claim, Verdict, WalletSession } from "@/lib/types";
import { formatUsdt, formatZar } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { Badge, Button, EmptyState, ExplorerLink, Notice, PageHeader } from "@/components/ui/primitives";
import { ReportCard } from "@/components/agent/report-card";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate, HeaderFrame } from "@/components/shell/gate";
import { usePay } from "@/components/pay/payment";
import { guardiansOf, guardianTodo, isMonitor } from "@/components/guardians/derive";
import { PausedNotice } from "@/components/guardians/parts";
import { GuardiansInbox } from "@/components/guardians/section";
import { ClaimWindow } from "@/components/guardians/claim-window";
import { DisputeList, DisputePanel, disputesToDecide } from "@/components/disputes/disputes";
import { pendingFor } from "@/components/shell/app-shell";
import { disputesVotedBy, effectiveStatus, openDisputeOn } from "@/lib/disputes/types";
import { useNow } from "@/lib/hooks/use-now";
import { openToPeople } from "@/lib/verdict";
import { canSign, claimPayable, claimTally, claimVote, declinedByOwner, hasInbox, deathTally, deathVote, hardshipStands, hardshipTally, hardshipVote, votesAlone, type Tally, type Vote } from "@/lib/guardians/decisions";
import { ClaimState, useWho, VoteNote, VoteTally } from "@/components/guardians/decision";
import { ReferredNote } from "@/components/continuity/continuity";

type Copy = ScreensCopy["inbox"];

/** What this person can act on in the inbox: approvals, guardians' votes and confirmations, disputes. */
export function inboxTodo(snap: EstateSnapshot, address: string): number {
  const now = Math.floor(Date.now() / 1000);
  return pendingFor(snap, address) + guardianTodo(guardiansOf(snap), snap, address, now) + disputesToDecide(snap, address, now);
}

interface Item {
  key: string;
  kind: "death" | "claim" | "hardship";
  title: string;
  body: string;
  amountZar?: string;
  report?: AgentReport;
  /** The agent's review tx, for when its report can't be loaded (the chain keeps only the report's hash). */
  reviewTx?: string;
  tally: Tally;
  verdict: Verdict;
  /** What this person can do: the program's rules (lib/guardians/decisions). */
  vote: Vote | null;
  /** Their yes decides alone (the only trusted person left, who gains): the wait or the window doubles. */
  alone?: boolean;
  claim?: Claim;
  /** A note in place of buttons. */
  note?: string;
  /** Claims, hardship sales and the unlock can be paused by a watcher's objection. */
  target?: string;
  /** Guard estates: a fully approved claim waits out the objection window, then anyone pays it. */
  payable?: { payee: string; payeeName: string; amount: bigint; successText: string };
  approveLabel: string;
  act: () => Promise<void>;
}

/** Animated with motion, so it brings its own <MotionScope> (the first pages never load the library). */
export function InboxScreen(props: Parameters<typeof InboxScreenBody>[0]) {
  return <MotionScope><InboxScreenBody {...props} /></MotionScope>;
}

function InboxScreenBody({ copy: english }: { copy: Copy }) {
  const copy = useLocalized(english, (t) => t.screens.inbox);
  return <Gate roles={["verifier", "monitor"]} allow={(snap, session) => hasInbox(snap, session.address, session.role, snap ? inboxTodo(snap, session.address) : 0)} frame={<HeaderFrame width="max-w-2xl" eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />}>{({ snap, session }) => <Inbox copy={copy} snap={snap!} session={session} />}</Gate>;
}

function Inbox({ copy, snap, session }: { copy: Copy; snap: EstateSnapshot; session: WalletSession }) {
  const { common, disputes: dc, guardians: gc } = useCopy();
  const { fx, run, busy } = useEstate();
  const [declined, setDeclined] = useState<string[]>([]);
  const { pay } = usePay();
  const e = snap.estate;
  const rate = fx?.usdtZar ?? null;
  const me = e.verifiers.indexOf(session.address);
  const who = useWho(snap);
  const label = (wallet: string) => snap.beneficiaries.find((b) => b.wallet === wallet)?.label ?? who(wallet);
  const now = useNow(15000);
  const g = guardiansOf(snap);
  const guardianCount = guardianTodo(g, snap, session.address, now) + (isMonitor(g, session.address) ? 1 : 0);

  // Watchers who are not trusted people only see the guardians part below.
  const items: Item[] = [];
  // Would this person's approval reach the quorum? Stale approvals don't count towards it.
  const finishes = (c: Claim) => claimTally(e, {
    ...c, approvalsCount: true, approvals: c.approvals.map((v, j) => j === me || (c.approvalsCount !== false && v)),
  }).met;
  const d = e.death;
  if (me >= 0 && e.status === "Active" && d.certHash && openToPeople(d.verdict)) {
    items.push({
      key: "death", kind: "death",
      title: fmt(copy.death.title, { name: e.ownerName }),
      body: fmt(copy.death.body, { by: d.submittedBy ? label(d.submittedBy) : "" }),
      report: d.agentReport,
      reviewTx: snap.activity.find((a) => a.kind === "DeathReviewed")?.txSignature,
      tally: deathTally(e), verdict: d.verdict, vote: deathVote(e, session.address), approveLabel: copy.death.approve,
      alone: votesAlone(e, d.submittedBy, d.verdict, session.address),
      act: async () => { await run("death", (s, est) => s.attestDeath(est), copy.death.done); },
    });
  }
  for (const c of me >= 0 && e.status === "Unlocked" ? snap.claims.filter((x) => x.status === "Open" && openToPeople(x.agentVerdict)) : []) {
    const rule = snap.rules.find((r) => r.address === c.rule);
    const payee = who(c.payee);
    const vote = claimVote(snap, c, session.address, now);
    const current = rule && !c.fromEndedRule ? rule : undefined;
    items.push({
      key: c.address, kind: "claim", target: c.address,
      title: fmt(copy.claim.title, { amount: formatUsdt(c.amount), payee }),
      body: current ? fmt(copy.claim.body, {
        name: label(c.beneficiary), category: common.status.category[current.category].toLowerCase(),
        left: formatUsdt(current.lifetimeCap - current.spentTotal - c.amount, { decimals: 0 }),
      }) : label(c.beneficiary),
      amountZar: rate ? formatZar(c.amount, rate) : undefined,
      report: c.agentReport, claim: c, tally: claimTally(e, c), verdict: c.agentVerdict, vote, alone: votesAlone(e, c.beneficiary, c.agentVerdict, session.address),
      approveLabel: finishes(c) && !g?.enabled ? copy.claim.approve : copy.claim.approveOnly,
      note: declinedByOwner(snap, c) ? gc.rules.vote.declined : undefined,
      payable: claimPayable(snap, c, now) ? { payee: c.payee, payeeName: payee, amount: c.amount, successText: fmt(copy.claim.done, { payee }) } : undefined,
      act: async () => {
        // Approve, and if that completes the quorum, release the payment in the same breath. With watchers (a Guard),
        // the payment waits out the objection window first, so only approve here.
        if (finishes(c) && !g?.enabled && !openDisputeOn(snap.disputes, c.address, now ?? 0)) {
          // "Try again" in the payment sheet re-runs execute: don't approve a second time (the program rejects that).
          let approved = !canSign(vote);
          await pay({
            kind: "claim-payout", source: "vault", to: c.payee, toLabel: payee, amount: c.amount, ...(approved ? {} : { approve: "verifier" as const, claim: c.address }),
            execute: async (s, est, again) => {
              if (!approved && again) {
                const fresh = await s.getEstate(est);
                const now = fresh.claims.find((x) => x.address === c.address);
                approved = !now || !canSign(claimVote(fresh, now, session.address, Math.floor(Date.now() / 1000)));
              }
              if (!approved) { await s.approveClaim(est, c.address); approved = true; }
              return s.executeClaim(est, c.address);
            },
            successText: fmt(copy.claim.done, { payee }),
          });
        } else {
          await run(c.address, (s, est) => s.approveClaim(est, c.address), copy.hardship.done);
        }
      },
    });
  }
  for (const h of me >= 0 ? snap.hardships.filter((x) => x.status === "Open" && openToPeople(x.agentVerdict)) : []) {
    const asset = snap.assets.find((a) => a.address === h.asset);
    if (asset?.status === "Sold") continue;
    items.push({
      key: h.address, kind: "hardship", target: h.address,
      title: fmt(copy.hardship.title, { name: label(h.beneficiary) }),
      body: asset ? fmt(copy.hardship.body, { floor: formatUsdt(asset.hardshipFloor, { decimals: 0 }), min: formatUsdt(asset.floorPrice, { decimals: 0 }), name: label(h.beneficiary).split(" ")[0] }) : "",
      report: h.agentReport, tally: hardshipTally(e, h), verdict: h.agentVerdict, vote: hardshipVote(snap, h, session.address), approveLabel: copy.hardship.approve,
      note: hardshipStands(snap, h) ? gc.rules.vote.stands : undefined,
      act: async () => { await run(h.address, (s, est) => s.approveHardship(est, h.address), copy.hardship.done); },
    });
  }

  const actionable = (i: Item) => !i.payable && canSign(i.vote);
  const todo = items.filter(actionable);
  const waiting = items.filter((i) => !actionable(i));
  const handled: { key: string; text: string; tag: string }[] = [
    ...(e.status !== "Active" && d.attestations[me] ? [{ key: "death", text: fmt(copy.death.title, { name: e.ownerName }), tag: copy.confirmed }] : []),
    ...snap.claims.filter((c) => c.status === "Paid" && c.approvals[me]).map((c) => ({ key: c.address, text: fmt(copy.claim.title, { amount: formatUsdt(c.amount, { decimals: 0 }), payee: who(c.payee) }), tag: copy.paid })),
    // Disputes this trusted person voted on (upheld, dismissed, lapsed, or still waiting for a second vote).
    ...disputesVotedBy(snap.disputes, me).map((x) => {
      const claim = x.kind === "Claim" ? snap.claims.find((c) => c.address === x.target) : undefined;
      const about = x.kind === "Unlock" ? dc.card.aboutUnlock
        : claim ? fmt(dc.card.aboutClaim, { amount: formatUsdt(claim.amount, { decimals: 0 }), payee: who(claim.payee) }) : "";
      return { key: x.address, text: [fmt(dc.card.by, { name: x.disputerName }), about].filter(Boolean).join(" · "), tag: dc.card.status[now === null ? x.status : effectiveStatus(x, now)] };
    }),
  ];
  const icons: Record<Item["kind"], ReactNode> = {
    death: <FileHeart className="size-5" aria-hidden="true" />, claim: <Banknote className="size-5" aria-hidden="true" />, hardship: <HandHeart className="size-5" aria-hidden="true" />,
  };

  const card = (it: Item) => {
    const isDeclined = declined.includes(it.key);
    return (
      <motion.li key={it.key} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full border-[1.5px] border-dashed border-ink text-ink">{icons[it.kind]}</span>
          <div className="min-w-0 flex-1">
            <Badge tone="warn">{copy.kinds[it.kind]}</Badge>
            <h2 className="mt-1.5 text-h3">{it.title}</h2>
            {it.amountZar && <p className="text-small text-ink-2 tabular-nums">≈ {it.amountZar}</p>}
            <p className="mt-1 text-ink-2">{it.body}</p>
          </div>
        </div>
        {it.target && <PausedNotice target={it.target} className="mt-3" />}
        {it.target && it.kind === "claim" && <DisputePanel kind="Claim" target={it.target} className="mt-3" />}
        {it.report ? <div className="mt-4"><ReportCard report={it.report} /></div> : (
          // The card only shows what the agent approved; without its report the trusted person is told so, and where
          // the review is recorded, before confirming.
          <Notice className="mt-4" tone="neutral" icon={<ScanSearch className="size-5" aria-hidden="true" />} title={copy.reportMissing.title}>
            <p>{copy.reportMissing.body}</p>
            {it.reviewTx && <ExplorerLink className="mt-1" signature={it.reviewTx} label={copy.reportMissing.link} srLabel={copy.reportMissing.sr} />}
          </Notice>
        )}
        <ReferredNote verdict={it.verdict} />
        <div className="mt-4"><VoteTally tally={it.tally} kind={it.kind === "death" ? "confirmed" : "approved"} names={e.verifierNames} /></div>
        {it.claim && <ClaimState snap={snap} claim={it.claim} />}
        {it.note && <p className="mt-3 text-small font-semibold">{it.note}</p>}
        <VoteNote vote={it.vote} death={it.kind === "death"} alone={it.alone} />
        {it.payable && it.target ? (
          <ClaimWindow claim={it.target} {...it.payable} />
        ) : it.vote === "waiting" ? (
          <p className="mt-3 flex items-center gap-2 text-small font-medium text-ok"><Check className="size-4" aria-hidden="true" />{copy.already}</p>
        ) : !canSign(it.vote) ? null : isDeclined ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 p-3">
            <p className="text-small" role="status">{copy.declined}</p>
            <Button variant="ghost" small onClick={() => setDeclined((x) => x.filter((k) => k !== it.key))}><Undo2 className="size-4" aria-hidden="true" />{copy.undo}</Button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="secondary" className="flex-1" disabled={!!busy} onClick={() => setDeclined((x) => [...x, it.key])}>{copy.decline}</Button>
            <Button className="flex-[2]" loading={busy === it.key || (it.kind === "death" && busy === "death")} disabled={!!busy} onClick={() => void it.act()}>
              <Check className="size-5" aria-hidden="true" />{it.vote === "complete" ? gc.rules.vote.completeCta : it.vote === "again" ? gc.rules.vote.againCta : it.approveLabel}
            </Button>
          </div>
        )}
      </motion.li>
    );
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      {todo.length === 0 && waiting.length === 0
        ? guardianCount > 0 ? null : <EmptyState icon={<InboxIcon className="size-6" aria-hidden="true" />} title={copy.empty.title} body={copy.empty.body} />
        : <ul className="grid gap-4"><AnimatePresence initial={false}>{[...todo, ...waiting].map(card)}</AnimatePresence></ul>}
      <DisputeList snap={snap} className="mt-5" />
      <GuardiansInbox snap={snap} className={todo.length + waiting.length > 0 ? "mt-5" : undefined} />

      <section aria-labelledby="handled" className="mt-8">
        <h2 id="handled" className="mb-2 font-sans text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.handled}</h2>
        {handled.length === 0 ? <p className="text-small text-ink-2">{copy.handledEmpty}</p> : (
          <ul>
            {handled.map((h) => (
              <li key={h.key} className="flex items-center justify-between gap-3 border-b border-line/70 py-2.5 text-small last:border-0">
                <span className="min-w-0 truncate">{h.text}</span>
                <Badge tone="ok">{h.tag}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
