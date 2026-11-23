"use client";
/**
 * The owner's check-in on the estate screen (dead man's switch, plan.md U8): one clear "I'm still here" button,
 * when they last checked in, how long until the next one is due, and a gentle reminder as it gets close.
 * The interval is the app's plan (lib/checkin.ts): the contract only records the heartbeat. Trusted people,
 * family and monitors see a notice once a check-in is overdue (CheckInWatch).
 */
import clsx from "clsx";
import { ArrowRight, BellRing, HeartPulse } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import type { EstateSnapshot } from "@/lib/service";
import { isMockService } from "@/lib/service/is-mock";
import { checkInPlan, checkInStatus, type CheckInStatus } from "@/lib/checkin";
import { useEstate } from "@/lib/hooks/estate";
import { Badge, Button, ButtonLink, Card, Eyebrow, Meter, Notice, type Tone } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { useStillHere } from "@/components/guardians/decision";

type Copy = ScreensCopy["estate"]["checkIn"];

const TONE: Record<Exclude<CheckInStatus["state"], "off">, Tone> = { ok: "ok", soon: "warn", overdue: "danger", never: "warn" };

export function lastLabel(st: CheckInStatus, c: Copy): string {
  if (st.state === "never") return c.never;
  return st.daysSince === 0 ? c.today : st.daysSince === 1 ? c.oneDayAgo : fmt(c.daysAgo, { n: st.daysSince });
}

export function nextLabel(st: CheckInStatus, c: Copy): string {
  if (st.state === "never" || st.daysLeft === 0) return c.dueNow;
  if (st.daysLeft < 0) return st.daysLeft === -1 ? c.overdueOne : fmt(c.overdueBy, { n: -st.daysLeft });
  return st.daysLeft === 1 ? c.dueInOne : fmt(c.dueIn, { n: st.daysLeft });
}

/** The owner's card. Renders nothing when the switch does not apply (passing reported, unlocked, frozen). */
export function CheckInCard({ copy: c, snap, now }: { copy: Copy; snap: EstateSnapshot; now: number | null }) {
  const { service, isMock, busy, refresh, notify, explain } = useEstate();
  const here = useCopy().guardians.rules.here;
  const { checkIn, cancels } = useStillHere(c.done);
  const plan = checkInPlan(isMock ? "mock" : "chain");
  if (now === null) return <Card aria-busy="true" className="min-h-40" />;
  const st = checkInStatus(snap.estate, now, plan);
  if (st.state === "off") {
    if (!cancels) return null;
    // A reported passing: the same button, and what it cancels (U1).
    return (
      <Card aria-labelledby="checkin-title" role="region" className="border-2 border-l-8 border-ink">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        <h2 id="checkin-title" className="mt-1.5 text-h3">{here.title}</h2>
        <p className="mt-1 text-ink-2">{here.body}</p>
        <p className="mt-2 font-semibold">{here.warning}</p>
        <Button className="mt-3" onClick={() => void checkIn()} loading={busy === "heartbeat"}>
          <HeartPulse className="size-5" aria-hidden="true" />{c.cta}
        </Button>
      </Card>
    );
  }
  const urgent = st.state === "overdue" || st.state === "soon" || st.state === "never";
  const mock = isMockService(service) ? service : null;
  const demo = async (daysLeft: number) => {
    if (!mock) return;
    try { mock.setCheckInDaysLeft(daysLeft); await refresh(); } catch (e) { notify("error", explain(e).message); }
  };

  return (
    <Card aria-labelledby="checkin-title" role="region" className={clsx(st.state === "overdue" && "border-2 border-l-8 border-ink", st.state === "soon" && "border-[1.5px] border-dashed border-ink")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        <Badge tone={TONE[st.state]}>{c.states[st.state]}</Badge>
      </div>
      <div className="mt-1.5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-md">
          <h2 id="checkin-title" className="text-h3">{st.state === "soon" ? c.soon.title : st.state === "overdue" ? c.overdue.title : c.title}</h2>
          <p className="mt-1 text-ink-2">
            {st.state === "soon" ? fmt(c.soon.body, { n: Math.max(1, st.daysLeft) }) : st.state === "overdue" ? c.overdue.body : st.state === "never" ? fmt(c.neverBody, { every: plan.everyDays }) : fmt(c.body, { every: plan.everyDays })}
          </p>
        </div>
        <Button onClick={() => void checkIn()} loading={busy === "heartbeat"} variant={urgent ? "primary" : "secondary"}>
          <HeartPulse className="size-5" aria-hidden="true" />{c.cta}
        </Button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-md border border-line-strong bg-surface-2 px-3 py-2">
          <dt className="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-ink-2">{c.last}</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{lastLabel(st, c)}</dd>
        </div>
        <div className="min-w-0 rounded-md border border-line-strong bg-surface-2 px-3 py-2">
          <dt className="text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-ink-2">{c.next}</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{nextLabel(st, c)}</dd>
        </div>
      </dl>
      <div className="mt-3"><Meter value={st.elapsed} label={fmt(c.meter, { every: plan.everyDays })} tone={st.state === "ok" ? "accent" : "danger"} /></div>
      <p className="mt-2 text-small text-ink-2">{c.onChain}{isMock ? ` ${c.demo.note}` : ""}</p>

      {mock && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => void demo(plan.remindDays - 7)} className="min-h-11 rounded-full border-[1.5px] border-dashed border-ink px-3.5 text-small font-semibold text-ink hover:bg-surface-2">{c.demo.soon}</button>
          <button type="button" onClick={() => void demo(-3)} className="min-h-11 rounded-full border-[1.5px] border-dashed border-ink px-3.5 text-small font-semibold text-ink hover:bg-surface-2">{c.demo.overdue}</button>
        </div>
      )}
    </Card>
  );
}

/** For everyone but the owner: a notice once the owner's check-in is overdue. */
export function CheckInWatch({ copy: c, snap, now }: { copy: Copy; snap: EstateSnapshot; now: number | null }) {
  const { isMock } = useEstate();
  if (now === null) return null;
  const plan = checkInPlan(isMock ? "mock" : "chain");
  const st = checkInStatus(snap.estate, now, plan);
  if (st.state !== "overdue") return null;
  const name = snap.estate.ownerName.split(" ")[0] || snap.estate.ownerName;
  return (
    <Notice tone="warn" icon={<BellRing className="size-5" aria-hidden="true" />} title={fmt(c.watch.title, { name, n: st.daysSince })}>
      <p>{fmt(c.watch.body, { name, every: plan.everyDays })}</p>
      <ButtonLink href="/family" variant="secondary" small className="mt-2">{c.watch.cta}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>
    </Notice>
  );
}
