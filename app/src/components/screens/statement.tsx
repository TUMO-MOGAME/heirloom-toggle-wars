"use client";
/**
 * The monthly statement (/statement?month=YYYY-MM; plan.md §13.4): what the plan paid in one South African
 * calendar month, to whom, for what and for whom, with each payment's receipt, totals per purpose and per person,
 * and (for the current month) what the schedules will pay next month. Built from the Proof drawer's activity feed
 * (lib/everyday/statement.ts), so it reads the same in the demo and on devnet. Printable (.print-sheet in
 * globals.css: the app's frame is hidden, black on white) and shareable (Web Share, else the link is copied).
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Copy as CopyIcon, FileText, Info, Send } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocale, useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot } from "@/lib/service";
import type { Base58 } from "@/lib/types";
import { formatUsdt, formatZar } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { nameOf } from "@/lib/people";
import {
  buildStatement, isMonthKey, monthKey, shiftMonth, statementMonths, upcoming, STATEMENT_TZ, type MonthKey, type Purpose,
} from "@/lib/everyday/statement";
import { Button, Card, EmptyState, Eyebrow, ExplorerLink, LoadingCards, Notice } from "@/components/ui/primitives";
import { Marked } from "@/components/ui/marked";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate } from "@/components/shell/gate";
import { ActivityText, useNameBook } from "@/components/shell/activity-text";
import { categoryIcon } from "./category-icon";
import { ReceiptButton } from "@/components/voice/receipt-button";

type Copy = ScreensCopy["statement"];

const noSubscribe = () => () => {};
/** `?month=` (read in the browser; undefined while prerendering, null when absent or not a month). */
function useMonthParam(): MonthKey | null | undefined {
  return useSyncExternalStore(noSubscribe, () => {
    const m = new URLSearchParams(window.location.search).get("month");
    return isMonthKey(m) ? m : null;
  }, () => undefined);
}

/** Intl locale for dates: Sesotho has no calendar data in every browser, so it falls back to South African English. */
const intlLocale = (l: string) => (l === "af" ? "af-ZA" : l === "zu" ? "zu-ZA" : "en-ZA");

export function StatementScreen({ copy: english }: { copy: Copy }) {
  const copy = useLocalized(english, (t) => t.screens.statement);
  const param = useMonthParam();
  if (param === undefined) return <LoadingCards label={copy.metaTitle} />;
  return (
    <Gate>
      {({ snap }) => (snap
        ? <Statement copy={copy} snap={snap} initial={param} />
        : <EmptyState level={1} icon={<FileText className="size-6" aria-hidden="true" />} title={copy.empty.title} body={copy.empty.body} />)}
    </Gate>
  );
}

function Statement({ copy, snap, initial }: { copy: Copy; snap: EstateSnapshot; initial: MonthKey | null }) {
  const { common } = useCopy();
  const locale = intlLocale(useLocale());
  const { fx, isMock } = useEstate();
  const book = useNameBook(snap);
  const [nowSecs] = useState(() => Math.floor(Date.now() / 1000));
  const current = monthKey(nowSecs);
  const months = useMemo(() => statementMonths(snap.activity, nowSecs), [snap.activity, nowSecs]);
  const [month, setMonthState] = useState<MonthKey>(() => (initial && months.includes(initial) ? initial : current));
  const [shared, setShared] = useState<"copied" | null>(null);
  const setMonth = (m: MonthKey) => {
    setMonthState(m);
    setShared(null);
    try { window.history.replaceState(window.history.state, "", `?month=${m}`); } catch { /* history blocked */ }
  };

  const fmtMonth = useMemo(() => {
    let f: Intl.DateTimeFormat;
    try { f = new Intl.DateTimeFormat(locale, { timeZone: STATEMENT_TZ, month: "long", year: "numeric" }); }
    catch { f = new Intl.DateTimeFormat("en-ZA", { timeZone: STATEMENT_TZ, month: "long", year: "numeric" }); }
    // Noon on the 15th of the month in UTC is always inside the same month in Johannesburg.
    return (m: MonthKey) => { const [y, mo] = m.split("-").map(Number); return f.format(new Date(Date.UTC(y, mo - 1, 15, 12))); };
  }, [locale]);
  const fmtDay = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { timeZone: STATEMENT_TZ, day: "numeric", month: "short" });
    return (ts: number) => f.format(new Date(ts * 1000));
  }, [locale]);
  const fmtLong = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { timeZone: STATEMENT_TZ, day: "numeric", month: "long", year: "numeric" });
    return (ts: number) => f.format(new Date(ts * 1000));
  }, [locale]);

  const st = useMemo(() => buildStatement(snap, month), [snap, month]);
  const next = shiftMonth(month, 1);
  const coming = useMemo(() => (month === current ? upcoming(snap, next) : null), [snap, month, current, next]);
  const rate = fx?.usdtZar ?? null;
  const zar = (b: bigint) => (rate ? formatZar(b, rate) : null);
  const label = fmtMonth(month);
  const purposeName = (p: Purpose) => (p === "Fallback" ? copy.fallback : p === "Unknown" ? copy.unknown : common.status.category[p]);
  const person = (w: Base58 | null) => (w ? nameOf(book, w) ?? copy.unknown : copy.unknown);
  const payeeName = (w: Base58 | null) => (w ? book.get(w)?.name ?? copy.unknown : copy.unknown);
  const receipts = useMemo(() => ({ estate: snap.estate.address, rules: snap.rules, assets: snap.assets }), [snap]);
  const i = months.indexOf(month);
  const older = i >= 0 && i < months.length - 1 ? months[i + 1] : null;
  const newer = i > 0 ? months[i - 1] : null;

  const share = async () => {
    const url = `${window.location.origin}/statement?month=${month}`;
    const title = fmt(copy.shareText, { estate: fmt(copy.forEstate, { name: snap.estate.ownerName }), month: label });
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title, text: title, url }); return; } catch (e) { if ((e as Error)?.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); setShared("copied"); window.setTimeout(() => setShared(null), 2500); } catch { /* clipboard blocked */ }
  };
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <article aria-labelledby="statement-title" className="print-sheet mx-auto grid max-w-4xl gap-5 *:min-w-0">
      <header className="min-w-0 border-b-2 border-ink pb-4">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1 id="statement-title" className="mt-1 text-h2"><Marked text={copy.title} /></h1>
        <p className="mt-2 text-ink-2">{copy.body}</p>
        <p className="mt-2 font-semibold">{fmt(copy.forEstate, { name: snap.estate.ownerName })} · {label}</p>
        <p className="mt-0.5 text-small text-ink-2">{fmt(copy.printed, { date: fmtLong(nowSecs) })}</p>
      </header>

      <div className="print-hide flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-1.5">
          <Button variant="secondary" small className="size-11 px-0!" disabled={!older} onClick={() => older && setMonth(older)} aria-label={copy.prev}><ChevronLeft className="size-5" aria-hidden="true" /></Button>
          <label className="flex flex-col gap-1 text-small font-semibold">
            {copy.month}
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="block min-h-11 rounded-md border border-line-strong bg-surface px-3 text-body text-ink hover:border-ink focus:border-ink">
              {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
            </select>
          </label>
          <Button variant="secondary" small className="size-11 px-0!" disabled={!newer} onClick={() => newer && setMonth(newer)} aria-label={copy.next}><ChevronRight className="size-5" aria-hidden="true" /></Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" small onClick={() => void share()}>
            {canShare ? <Send className="size-4" aria-hidden="true" /> : <CopyIcon className="size-4" aria-hidden="true" />}{canShare ? copy.share : copy.copyLink}
          </Button>
          <Button small onClick={() => window.print()}><FileText className="size-4" aria-hidden="true" />{copy.print}</Button>
        </div>
        <p className="w-full text-small text-ink-2" role="status">{shared === "copied" ? copy.copied : ""}</p>
      </div>

      {isMock && <Notice tone="warn" icon={<Info className="size-5" aria-hidden="true" />}>{copy.simulated}</Notice>}
      {!st.complete && <Notice icon={<Info className="size-5" aria-hidden="true" />}>{copy.partial}</Notice>}

      <Card className="print-avoid">
        <p className="text-small font-semibold text-ink-2">{fmt(copy.total, { month: label })}</p>
        <p className="mt-1 font-display text-h1 tabular-nums">{formatUsdt(st.total)}</p>
        <p className="text-small text-ink-2 tabular-nums">{zar(st.total) ? `≈ ${zar(st.total)} · ` : ""}{fmt(copy.count, { n: st.lines.length })}</p>
      </Card>

      <section aria-labelledby="statement-payments">
        <h2 id="statement-payments" className="text-h3">{fmt(copy.table.caption, { month: label })}</h2>
        {st.lines.length === 0 ? <p className="mt-2 text-ink-2">{fmt(copy.none, { month: label })}</p> : (
          <>
            {/* Phones: one card per payment. Wider screens and paper: a table. */}
            <ol className="mt-3 grid gap-2.5 sm:hidden print:hidden">
              {st.lines.map((l, n) => {
                const Icon = l.purpose === "Fallback" || l.purpose === "Unknown" ? null : categoryIcon[l.purpose];
                return (
                  <li key={`${l.txSignature}-${n}`} className="rounded-md border border-line bg-surface p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{payeeName(l.payee)}</p>
                        <p className="flex items-center gap-1.5 text-small text-ink-2">{Icon && <Icon className="size-4 shrink-0 text-amber" aria-hidden="true" />}{purposeName(l.purpose)} · {person(l.person)}</p>
                      </div>
                      <p className="shrink-0 text-right">
                        <span className="block font-semibold tabular-nums">{formatUsdt(l.amount)}</span>
                        {zar(l.amount) && <span className="block text-small text-ink-2 tabular-nums">≈ {zar(l.amount)}</span>}
                      </p>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3">
                      <span className="text-[0.75rem] text-ink-2">{fmtDay(l.ts)} · {l.scheduled ? copy.scheduled : l.kind === "FallbackExecuted" ? copy.fallback : copy.claim}</span>
                      <span className="flex flex-wrap items-center gap-x-2">
                        {l.txSignature && <ExplorerLink signature={l.txSignature} label={copy.receipt} srLabel={copy.receiptSr} className="min-h-9!" />}
                        <ReceiptButton item={l.item} demo={receipts} />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="mt-3 hidden overflow-x-auto sm:block print:block">
              <table className="w-full border-collapse text-small">
                <caption className="sr-only">{fmt(copy.table.caption, { month: label })}</caption>
                <thead>
                  <tr className="border-b-2 border-ink text-left">
                    <th scope="col" className="py-2 pr-3 font-semibold">{copy.table.date}</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">{copy.table.to}</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">{copy.table.what}</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">{copy.table.for}</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold">{copy.table.amount}</th>
                    <th scope="col" className="py-2 font-semibold">{copy.table.proof}</th>
                  </tr>
                </thead>
                <tbody>
                  {st.lines.map((l, n) => (
                    <tr key={`${l.txSignature}-${n}`} className="print-avoid border-b border-line align-top">
                      <td className="whitespace-nowrap py-2 pr-3">{fmtDay(l.ts)}</td>
                      <td className="py-2 pr-3 font-medium">{l.payee ? payeeName(l.payee) : <ActivityText item={l.item} book={book} />}</td>
                      <td className="py-2 pr-3">{purposeName(l.purpose)}<span className="block text-[0.75rem] text-ink-2">{l.scheduled ? copy.scheduled : l.kind === "FallbackExecuted" ? copy.fallback : copy.claim}</span></td>
                      <td className="py-2 pr-3">{person(l.person)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums"><span className="font-semibold">{formatUsdt(l.amount)}</span>{zar(l.amount) && <span className="block text-[0.75rem] text-ink-2">≈ {zar(l.amount)}</span>}</td>
                      <td className="py-2">
                        {l.txSignature && (
                          <>
                            <ExplorerLink signature={l.txSignature} label={copy.receipt} srLabel={copy.receiptSr} className="min-h-9! print-hide" />
                            <span className="hidden break-all font-mono text-[0.7rem] print:inline">{l.txSignature}</span>
                            <ReceiptButton item={l.item} demo={receipts} className="-ms-2" />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {st.lines.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
          <Totals title={copy.byPurpose} rows={st.byPurpose.map((t) => ({ key: t.key, label: purposeName(t.key), amount: t.amount, count: t.count }))} zar={zar} />
          <Totals title={copy.byPerson} rows={st.byPerson.map((t) => ({ key: t.key ?? "unknown", label: person(t.key), amount: t.amount, count: t.count }))} zar={zar} />
        </div>
      )}

      {coming && (
        <section aria-labelledby="statement-next" className="print-avoid">
          <h2 id="statement-next" className="flex items-center gap-2 text-h3"><CalendarClock className="size-5 text-amber" aria-hidden="true" />{fmt(copy.upcoming.title, { month: fmtMonth(next) })}</h2>
          <p className="mt-1 text-small text-ink-2">{copy.upcoming.body}</p>
          {coming.length === 0 ? <p className="mt-2 text-ink-2">{fmt(copy.upcoming.none, { month: fmtMonth(next) })}</p> : (
            <ul className="mt-3 grid gap-2">
              {coming.map((u) => (
                <li key={u.rule} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-md border border-line bg-surface p-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{payeeName(u.payee)}</p>
                    <p className="text-small text-ink-2">{common.status.category[u.purpose]} · {person(u.person)}{u.firstDue ? ` · ${fmt(copy.upcoming.from, { date: fmtDay(u.firstDue) })}` : ""}</p>
                  </div>
                  <p className="text-right tabular-nums">
                    <span className="block font-semibold">{formatUsdt(u.total)}</span>
                    <span className="block text-small text-ink-2">{fmt(copy.upcoming.line, { count: u.count, amount: formatUsdt(u.amount, { decimals: 0 }) })}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {isMock && coming.length > 0 && <p className="mt-2 text-[0.75rem] text-ink-2">{copy.upcoming.demo}</p>}
        </section>
      )}

      <footer className="border-t border-line pt-3 text-[0.75rem] text-ink-2">
        {fx && <p>{fmt(copy.rate, { rate: fx.usdtZar.toFixed(2), source: fx.source })}</p>}
        <p className="print-hide mt-1">{copy.shareNote}</p>
      </footer>
    </article>
  );
}

function Totals({ title, rows, zar }: { title: string; rows: { key: string; label: string; amount: bigint; count: number }[]; zar: (b: bigint) => string | null }) {
  return (
    <Card className="print-avoid">
      <h2 className="text-h3">{title}</h2>
      <dl className="mt-2">
        {rows.map((r) => (
          <div key={r.key} className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
            <dt className="min-w-0">{r.label} <span className="text-small text-ink-2">× {r.count}</span></dt>
            <dd className="shrink-0 text-right tabular-nums">
              <span className="block font-semibold">{formatUsdt(r.amount)}</span>
              {zar(r.amount) && <span className="block text-[0.75rem] text-ink-2">≈ {zar(r.amount)}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
