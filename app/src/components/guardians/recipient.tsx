"use client";
/**
 * A reported death of someone on the fallback list (R4): the agent's verdict, their own "I'm alive", a second
 * person's confirmation after the wait, and when a stalled report can be replaced. `AliveBanner` is on every page of
 * the app for the person reported.
 */
import { Check, HeartPulse, TriangleAlert } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import { canConfirmRecipient, fallbackReplace, reportsAbout } from "@/lib/guardians/decisions";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { ReportCard } from "@/components/agent/report-card";
import { clock, shortName } from "./derive";
import { ReplaceWhen, useWho } from "./decision";
import { ActionResult, useAction } from "./parts";

export function AliveBanner() {
  const t = useCopy().guardians.rules.recipient.alive;
  const { snap, session } = useEstate();
  const { act, busy, refusal } = useAction();
  if (!snap) return null;
  const mine = reportsAbout(snap, session?.address);
  if (!mine.length) return null;
  const index = mine[0];
  const key = `alive-${index}`;
  return (
    <section aria-labelledby="alive-title" className="mx-auto mb-5 w-full max-w-6xl">
      <Notice tone="danger" icon={<TriangleAlert className="size-6" aria-hidden="true" />}>
        <h2 id="alive-title" className="text-h3">{t.title}</h2>
        <p className="mt-1 text-body">{t.body}</p>
        <Button className="mt-3" loading={busy === key} disabled={!!busy} onClick={() => void act(key, (s, est) => s.resolveFallbackDeath(est, index, false), t.done)}>
          <HeartPulse className="size-5" aria-hidden="true" />{t.cta}
        </Button>
        <ActionResult receipt={null} refusal={refusal} />
      </Notice>
    </section>
  );
}

/** The open reports, with what this person can do about each. */
export function RecipientReports({ snap, className }: { snap: EstateSnapshot; className?: string }) {
  const t = useCopy().guardians.rules.recipient;
  const { session } = useEstate();
  const who = useWho(snap);
  const now = useNow();
  const { act, busy, receipt, refusal } = useAction();
  const g = snap.guardians;
  if (!g || g.fallback.done) return null;
  const open = g.fallback.recipients.flatMap((r, index) => (r.report && !r.dead ? [{ r, index, report: r.report }] : []));
  // The result outlives the report, which closes when it is confirmed or refuted.
  if (!open.length) return receipt || refusal ? <div className={className}><ActionResult receipt={receipt} refusal={refusal} /></div> : null;

  return (
    <div className={className}>
      <ul className="grid gap-3 *:min-w-0">
        {open.map(({ r, index, report }) => {
          const name = shortName(r.name);
          const wait = now === null ? null : report.confirmableAt - now;
          const over = wait !== null && wait <= 0;
          const key = `confirm-recipient-${index}`;
          return (
            <li key={`${index}-${report.reportedAt}`} className="rounded-md border-[1.5px] border-dashed border-ink bg-surface p-3">
              <p className="font-semibold">{fmt(t.title, { name })}</p>
              <p className="text-small text-ink-2">{fmt(t.by, { by: who(report.reporter) })}</p>
              {report.verdict === "Pending" ? <p className="mt-2 text-small">{t.pending}</p> : (
                <>
                  <p className="mt-2 text-small tabular-nums">{over ? fmt(t.ready, { name }) : wait === null ? "" : fmt(t.wait, { name, time: clock(wait) })}</p>
                  <p className="mt-1 text-small text-ink-2">{fmt(t.who, { name })}</p>
                  {report.report && <div className="mt-3"><ReportCard report={report.report} compact /></div>}
                  {over && canConfirmRecipient(snap, index, session?.address) && (
                    <Button className="mt-3" loading={busy === key} disabled={!!busy} onClick={() => void act(key, (s, est) => s.resolveFallbackDeath(est, index, true), t.confirmed)}>
                      <Check className="size-5" aria-hidden="true" />{fmt(t.confirm, { name })}
                    </Button>
                  )}
                </>
              )}
              <ReplaceWhen times={fallbackReplace(snap.estate, g.fallbackWaitSecs, report)} who="recipient" />
            </li>
          );
        })}
      </ul>
      <ActionResult receipt={receipt} refusal={refusal} />
    </div>
  );
}
