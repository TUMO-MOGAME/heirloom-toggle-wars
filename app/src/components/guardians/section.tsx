"use client";
/**
 * The guardians area, composed for each screen:
 * - `GuardiansPeople`: People screen — every trusted place with backups, watchers and succession; report a passing;
 *   objections; the fallback plan; the fallback status.
 * - `GuardiansInbox`: Inbox — the watcher's feed, objections to decide, passings to confirm or cancel.
 * - `SuccessionTimeline`: Timeline — who holds each place now and any change in progress.
 * - `GuardiansPlanLink`: Plan — a pointer to where backups and the fallback plan are set.
 */
import Link from "next/link";
import { ArrowRight, ShieldCheck, UsersRound } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, ButtonLink, Card } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { canConfirm, fallbackStage, heldSeat } from "./derive";
import { RecipientReports } from "./recipient";
import { FallbackPlanCard, FallbackStatus } from "./fallback";
import { MonitorFeed, ObjectionList } from "./objections";
import { ActionResult, useAction, useGuardians } from "./parts";
import { SeatCard } from "./seat-card";
import { ReportPassing, SuccessionStatus } from "./succession";

/** Owner, estate Active, no Guard yet: one button creates it (empty backups, watchers and fallback). */
function SetupCard({ snap }: { snap: EstateSnapshot }) {
  const { guardians: c } = useCopy();
  const { role, session } = useEstate();
  const { act, busy, receipt, refusal } = useAction();
  const e = snap.estate;
  const owner = role === "owner" && session?.address === e.owner && e.status === "Active";
  return (
    <Card className="md:col-span-2">
      <h2 className="flex items-center gap-2 text-h3"><UsersRound className="size-5" aria-hidden="true" />{c.setup.title}</h2>
      <p className="mt-1 text-ink-2">{owner ? c.setup.body : c.setup.off}</p>
      {owner && <p className="mt-1 text-small text-ink-2">{c.rules.watch}</p>}
      {owner && (
        <Button className="mt-3" loading={busy === "guard-setup"}
          onClick={() => void act("guard-setup", (s, est) => s.setupGuardians(est, { seats: [0, 1, 2].map((index) => ({ index, backups: [], monitors: [] })), fallback: [] }), c.setup.done)}>
          {c.setup.cta}
        </Button>
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </Card>
  );
}

export function GuardiansPeople({ snap }: { snap: EstateSnapshot }) {
  const { guardians: c } = useCopy();
  const g = useGuardians();
  if (!g) return null;
  if (!g.enabled) return <SetupCard snap={snap} />;
  return (
    <>
      <FallbackStatus snap={snap} className="md:col-span-2" />
      <Card id="guardians" className="min-w-0 scroll-mt-24 md:col-span-2">
        <h2 className="flex items-center gap-2 text-h3"><UsersRound className="size-5" aria-hidden="true" />{c.setup.title}</h2>
        <p className="mt-1 text-ink-2">{c.setup.body}</p>
        <ul className="mt-4 grid gap-3 *:min-w-0 lg:grid-cols-3">
          {g.seats.map((s) => <SeatCard key={s.index} seat={s} snap={snap} />)}
        </ul>
      </Card>
      <div className="md:col-span-2"><ReportPassing /></div>
      <Card className="md:col-span-2"><ObjectionList snap={snap} /></Card>
      <FallbackPlanCard snap={snap} className="min-w-0 md:col-span-2" />
    </>
  );
}

export function GuardiansInbox({ snap, className }: { snap: EstateSnapshot; className?: string }) {
  const { guardians: c } = useCopy();
  const { session } = useEstate();
  const g = useGuardians();
  const now = useNow(5000);
  if (!g || !g.enabled) return null;
  const me = session?.address;
  const reportsHere = fallbackStage(g, now) === "notNeeded";
  const mine = heldSeat(g, me);
  // Passings to act on: one I can confirm, or one reported about me ("I'm still here").
  const successions = g.seats.filter((s) => s.succession && (canConfirm(snap, s, me) || (mine && s.index === mine.index)));
  return (
    <div className={`grid gap-5 empty:hidden ${className ?? ""}`}>
      <FallbackStatus snap={snap} />
      {reportsHere && <RecipientReports snap={snap} />}
      {successions.length > 0 && (
        <section aria-labelledby="succession-inbox" className="rounded-xl border border-line bg-surface p-4 sm:p-5">
          <h2 id="succession-inbox" className="text-h3">{c.inbox.successionTitle}</h2>
          {successions.map((s) => <SuccessionStatus key={s.index} seat={s} />)}
        </section>
      )}
      <ObjectionList snap={snap} onlyVotable title={c.inbox.objectionsTitle} className="rounded-xl border border-line bg-surface p-4 sm:p-5" />
      <MonitorFeed />
    </div>
  );
}

export function SuccessionTimeline({ snap }: { snap: EstateSnapshot }) {
  const { guardians: c } = useCopy();
  const g = useGuardians();
  const now = useNow(5000);
  if (!g || !g.enabled) return null;
  const t = c.timeline;
  return (
    <>
      <FallbackStatus snap={snap} className="mt-6" />
      {fallbackStage(g, now) === "notNeeded" && <RecipientReports snap={snap} className="mt-6" />}
      <section aria-labelledby="succession-timeline" className="mt-6">
        <h2 id="succession-timeline" className="text-h3">{t.title}</h2>
        <p className="mt-1 text-small text-ink-2">{t.body}</p>
        <ol className="mt-3 flex flex-col gap-2">
          {g.seats.map((s) => (
            <li key={s.index} className="rounded-lg border border-line bg-surface p-3.5">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                <ShieldCheck className="size-4" aria-hidden="true" />{s.vacant ? c.vacant : s.holderName}
                <span className="text-small font-normal text-ink-2">· {c.seats[s.index]}</span>
              </p>
              {!s.vacant && (
                <p className="mt-1 text-small text-ink-2">
                  {s.generation === 0 ? c.generation.first : fmt(c.generation.later, { n: s.generation + 1 })}
                </p>
              )}
              {s.succession && <SuccessionStatus seat={s} />}
            </li>
          ))}
        </ol>
        <Link href="/people#guardians" className="mt-2 inline-flex min-h-11 items-center gap-2 text-small font-semibold underline-offset-4 hover:underline">
          {c.plan.cta}<ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}

export function GuardiansPlanLink() {
  const { guardians: c } = useCopy();
  return (
    <Card className="mt-5">
      <h2 className="flex items-center gap-2 text-h3"><UsersRound className="size-5" aria-hidden="true" />{c.plan.title}</h2>
      <p className="mt-1 text-ink-2">{c.plan.body}</p>
      <ButtonLink href="/people#guardians" variant="secondary" small className="mt-3">{c.plan.cta}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>
    </Card>
  );
}
