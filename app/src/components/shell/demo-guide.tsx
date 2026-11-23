"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Compass, Repeat } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { WalletSession } from "@/lib/types";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useEstate } from "@/lib/hooks/estate";
import { shortName } from "@/lib/names";
import { claimedAfterDeath, scheduleStepDue } from "@/lib/schedule-step";
import type { CommonCopy } from "@/content/common";
import { fmt, useCopy } from "./copy";
import { openToPeople } from "@/lib/verdict";
import { canSign, claimBlock, claimPayable, claimVote, deathTally, deathVote, isFamily, isHeld } from "@/lib/guardians/decisions";

type StepKey = keyof CommonCopy["demo"]["steps"];
const ORDER: StepKey[] = ["will", "fund", "schedule", "car", "ask", "answer", "report", "attest", "wait", "claim", "approve", "list", "offer", "settle", "done"];

interface Step { key: StepKey; actor: WalletSession | null; href: string; vars?: Record<string, number> }

function nextStep(snap: EstateSnapshot | null, sessions: WalletSession[]): Step {
  const by = (role: WalletSession["role"]) => sessions.filter((s) => s.role === role);
  const owner = by("owner")[0] ?? null;
  if (!snap) return { key: "will", actor: owner, href: "/will" };
  const e = snap.estate;
  const ownerS = sessions.find((s) => s.address === e.owner) ?? owner;
  const kid = sessions.find((s) => isFamily(snap, s.address)) ?? by("beneficiary")[0] ?? null;
  const person = (address: string | undefined) => sessions.find((s) => s.address === address) ?? null;
  const holders = e.verifiers.filter(isHeld);
  const now = Math.floor(Date.now() / 1000);
  const buyer = by("buyer")[0] ?? null;
  const car = snap.assets[0];
  if (e.status === "Active") {
    if (e.vaultBalance === BigInt(0)) return { key: "fund", actor: ownerS, href: "/vault" };
    if (!e.death.certHash && scheduleStepDue(snap.rules, Math.floor(Date.now() / 1000))) return { key: "schedule", actor: ownerS, href: "/estate" };
    if (!car) return { key: "car", actor: ownerS, href: "/car" };
    // Everyday money: a child asks under a "starts now" claim rule, then Thabo answers on his chat home.
    if (!e.death.certHash) {
      const everyday = snap.rules.find((r) => r.startsNow && r.category === "General" && r.recurringAmount === BigInt(0));
      const asks = everyday ? snap.claims.filter((c) => c.rule === everyday.address) : [];
      const waiting = asks.find((c) => c.status === "Open" && openToPeople(c.agentVerdict) && !c.ownerApproved && !snap.asks?.[c.address]?.declinedAt && !claimBlock(snap, c, now));
      if (waiting) return { key: "answer", actor: ownerS, href: "/chat" };
      if (everyday && asks.length === 0 && now <= everyday.validUntil && isFamily(snap, everyday.beneficiary)) return { key: "ask", actor: sessions.find((s) => s.address === everyday.beneficiary) ?? kid, href: "/chat" };
    }
    if (!e.death.certHash) return { key: "report", actor: kid, href: "/family" };
    const t = deathTally(e);
    const next = holders.find((v) => canSign(deathVote(e, v)));
    return { key: "attest", actor: person(next ?? holders[0]), href: "/inbox", vars: { got: t.got, need: t.needed } };
  }
  if (e.status === "DeathPending") return { key: "wait", actor: kid, href: "/family" };
  // The story's fee claim: one made after the passing, not an everyday request from before it (those carry a note).
  if (!claimedAfterDeath(snap)) return { key: "claim", actor: kid, href: "/claims" };
  // A claim nobody can ever pay, or with nobody left to decide it, is not a step.
  const open = snap.claims.find((c) => c.status === "Open" && (claimPayable(snap, c, now) || holders.some((v) => canSign(claimVote(snap, c, v, now)))));
  if (open) {
    const signer = holders.find((v) => canSign(claimVote(snap, open, v, now)));
    return { key: "approve", actor: person(claimPayable(snap, open, now) ? holders[0] : signer), href: "/inbox" };
  }
  if (car?.status === "Held") return { key: "list", actor: person(holders[0]), href: "/car" };
  if (car?.status === "Listed") {
    const mine = buyer && snap.offers.some((o) => o.buyer === buyer.address);
    return mine ? { key: "settle", actor: person(holders.find((v) => v !== buyer.address)) ?? kid, href: "/car" } : { key: "offer", actor: buyer, href: "/car" };
  }
  return { key: "done", actor: null, href: "/estate" };
}

/** A one-line guide under the header in demo mode: what happens next, and who does it. */
export function DemoGuide() {
  const { common } = useCopy();
  const d = common.demo;
  const wallet = useWallet();
  const { snap, session, phase, setProofOpen } = useEstate();
  const pathname = usePathname();
  // While the estate loads, hold the guide's height (min-h-14) so the page below doesn't jump when it appears.
  if (phase === "loading") return <div className="brand-panel min-h-14" aria-hidden="true" />;
  if (phase === "error") return null;
  const step = nextStep(snap, wallet.sessions);
  const copy = d.steps[step.key];
  const n = ORDER.indexOf(step.key) + 1;
  const wrongPerson = step.actor && step.actor.address !== session?.address;
  const wrongPage = pathname !== step.href;
  const first = step.actor ? shortName(step.actor.label) : "";
  const pill = "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-small font-semibold text-bg";

  return (
    <div className="brand-panel">
      <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-3 px-4 py-1.5" role="status" aria-live="polite">
        <Compass className="hidden size-5 shrink-0 sm:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.7rem] font-semibold uppercase tracking-wider text-ink-2">
            {d.guideLabel}{step.key !== "done" && <> · {fmt(d.stepOf, { n, total: ORDER.length - 1 })}</>}
          </p>
          <p className="truncate text-small font-semibold" title={copy.body}>{fmt(copy.title, step.vars ?? {})}</p>
        </div>
        {step.key === "done" ? (
          <button type="button" onClick={() => setProofOpen(true)} className={pill}>{common.proof.open}<ArrowRight className="size-4" aria-hidden="true" /></button>
        ) : wrongPerson && step.actor ? (
          <button type="button" onClick={() => wallet.switchTo(step.actor!.address)} className={pill}>
            <Repeat className="size-4" aria-hidden="true" />
            <span className="max-w-[9.5rem] truncate">{fmt(d.switchTo, { name: first })}</span>
          </button>
        ) : wrongPage ? (
          <Link href={step.href} className={pill}>{d.go}<ArrowRight className="size-4" aria-hidden="true" /></Link>
        ) : null}
      </div>
    </div>
  );
}
