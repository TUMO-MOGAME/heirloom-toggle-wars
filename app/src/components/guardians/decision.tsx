"use client";
/**
 * Small pieces every decision shares (plan §18.4): who counts towards a quorum, when a stalled report can be replaced,
 * why a claim can't be paid, and the check-in that cancels a reported passing.
 */
import { TriangleAlert } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { Base58, Claim } from "@/lib/types";
import { canSign, claimBlock, deathOpen, type ReplaceTimes, type Tally, type Vote } from "@/lib/guardians/decisions";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { useNameBook } from "@/components/shell/activity-text";
import { Quorum } from "@/components/ui/client";
import { fmt, useCopy } from "@/components/shell/copy";
import { shortAddress } from "@/lib/format";
import { clock } from "./derive";

/** A person's or payee's name, also once removed from the plan; else the short address. */
export function useWho(snap: EstateSnapshot | null | undefined): (wallet: Base58 | null | undefined) => string {
  const book = useNameBook(snap);
  return (wallet) => (wallet ? book.get(wallet)?.name ?? shortAddress(wallet) : "");
}

/** Dots, then "1 of 2 approved · 3 can decide". Only votes that count are filled. */
export function VoteTally({ tally, names, kind = "approved" }: { tally: Tally; names?: readonly string[]; kind?: "approved" | "confirmed" }) {
  const t = useCopy().guardians.rules.tally;
  const label = tally.eligible === 0 ? t.nobody : fmt(t[kind], { got: tally.got, need: tally.needed, eligible: tally.eligible });
  return <Quorum approvals={tally.votes} needed={tally.needed} names={names} label={label} />;
}

/**
 * Why this person is asked again, or can't act. `alone`: they are the only trusted person left and gain from it, so
 * their yes decides alone and doubles the wait (a death) or the objection window (a claim).
 */
export function VoteNote({ vote, death = false, alone = false, className = "mt-3" }: { vote: Vote | null; death?: boolean; alone?: boolean; className?: string }) {
  const t = useCopy().guardians.rules.vote;
  const text = vote === "own" ? (death ? t.ownDeath : t.own) : vote === "complete" ? t.complete : vote === "again" ? t.again : null;
  const lone = alone && canSign(vote) ? (death ? t.aloneDeath : t.aloneClaim) : null;
  if (!text && !lone) return null;
  return (
    <div className={`grid gap-1 text-small font-semibold ${className}`}>
      {lone && <p>{lone}</p>}
      {text && <p>{text}</p>}
    </div>
  );
}

/** An open claim that can't be paid, or whose approvals have to be given again. */
export function ClaimState({ snap, claim, className = "mt-3" }: { snap: EstateSnapshot; claim: Claim; className?: string }) {
  const t = useCopy().guardians.rules;
  const now = useNow(15000);
  if (claim.status !== "Open") return null;
  const block = claimBlock(snap, claim, now);
  const text = block ? t.blocked[block] : claim.approvalsCount === false && snap.estate.status === "Unlocked" && !claim.ownerApproved ? t.vote.stale : null;
  return text ? (
    <p className={`flex items-start gap-2 text-small font-semibold ${className}`}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span className="min-w-0">{text}</span>
    </p>
  ) : null;
}

/** Who can replace a stalled report, and from when. */
export function ReplaceWhen({ times, who, className = "mt-3" }: { times: ReplaceTimes | null; who: "death" | "seat" | "recipient"; className?: string }) {
  const t = useCopy().guardians.rules.replace;
  const now = useNow();
  if (!times || now === null) return null;
  // An unreviewed death claim is never replaced: it waits for the agent's review.
  if (!Number.isFinite(times.others)) {
    return <div className={`min-w-0 text-small ${className}`}><p className="font-semibold">{t.title}</p><p className="text-ink-2">{t.untilReviewed}</p></div>;
  }
  const line = (at: number, person: string) => (now >= at ? fmt(t.now, { who: person }) : fmt(t.in, { who: person, time: clock(at - now) }));
  return (
    <div className={`min-w-0 text-small ${className}`}>
      <p className="font-semibold">{t.title}</p>
      <p className="text-ink-2 tabular-nums">{line(times.others, t.who[who])}</p>
      <p className="text-ink-2 tabular-nums">{line(times.reporter, t.who.reporter)}</p>
    </div>
  );
}

/**
 * "I'm still here": the check-in, which cancels an open death claim (R1). It reads the estate back before it says so,
 * so nobody is thanked while a report continues.
 */
export function useStillHere(thanks: string): { checkIn: () => Promise<void>; cancels: boolean } {
  const { service, snap, estate, run, notify } = useEstate();
  const t = useCopy().guardians.rules.here;
  const cancels = !!snap && deathOpen(snap.estate);
  const checkIn = async () => {
    const res = await run("heartbeat", (svc, est) => svc.heartbeat(est));
    if (!res.ok || !service || !estate) return;
    try {
      const open = deathOpen((await service.getEstate(estate)).estate);
      notify(open ? "error" : "ok", open ? t.stillOpen : cancels ? t.done : thanks);
    } catch {
      notify("info", t.unread);
    }
  };
  return { checkIn, cancels };
}
