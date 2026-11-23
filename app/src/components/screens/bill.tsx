"use client";
/**
 * Pay a bill once (plan.md §13.2). The owner pays a lawyer, a plumber or a school trip from their own Tether wallet,
 * through the one payment flow (review → approve → WDK signs → pending → confirmed, pay-once). Never from the vault.
 * Optional invoice: the AI reads amount, payee and reference; compareInvoice() shows plainly where it disagrees with
 * what was typed, on the form and again in the review sheet. The person decides; nothing here blocks a payment.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ComponentType } from "react";
import clsx from "clsx";
import {
  ArrowRight, Banknote, Building2, CircleAlert, FileText, GraduationCap, House, Scale, Sparkles, Stethoscope, Store, UserRoundPlus, Wallet, X,
} from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocalized } from "@/lib/i18n/client";
import { formatUsdt, formatUsdtExact, shortAddress, toBase } from "@/lib/format";
import { amountHint, amountText, parseAmount } from "@/lib/amount";
import { checkEvidence, EVIDENCE_ACCEPT } from "@/lib/evidence";
import { useEstate } from "@/lib/hooks/estate";
import { BILL_KINDS, type BillDetails, type BillKind, type BillPayee, type PaidBill } from "@/lib/bills/types";
import { compareInvoice, zarToUsdt, type InvoiceComparison, type InvoiceIssue, type InvoiceRead } from "@/lib/bills/invoice";
import { billPayeeInputSchema } from "@/lib/bills/payees";
import { Badge, Button, ButtonLink, Card, ExplorerLink, Field, inputClass, Notice, PageHeader, Skeleton } from "@/components/ui/primitives";
import { usePay } from "@/components/pay/payment";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate, HeaderFrame } from "@/components/shell/gate";

type Copy = ScreensCopy["bill"];
const KIND_ICON: Record<BillKind, ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
  lawyer: Scale, plumber: House, school: GraduationCap, doctor: Stethoscope, builder: Building2, other: Store,
};

export function BillScreen({ copy: english }: { copy: Copy }) {
  const copy = useLocalized(english, (t) => t.screens.bill);
  return <Gate allowEmpty frame={<HeaderFrame width="max-w-md" eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />}>{() => <Bill copy={copy} />}</Gate>;
}

/** One plain sentence per invoice issue, from the copy (exported for tests). */
export function issueText(i: InvoiceIssue, c: Copy["invoice"]): string {
  const v = { invoice: i.invoice ?? "", typed: i.typed ?? "" };
  if (i.field === "document") return i.reason === "notInvoice" ? c.unread.notInvoice : c.unread.lowConfidence;
  if (i.level === "info") return i.reason === "rate" ? fmt(c.issues.rate, v) : i.reason === "currency" ? c.issues.currency : fmt(c.issues.addReference, v);
  return fmt(c.issues[i.field], v);
}

interface InvoiceState { file: File; status: "reading" | "done" | "error"; result?: InvoiceRead }

function Bill({ copy }: { copy: Copy }) {
  const { service, fx, walletUsdt, session, explain } = useEstate();
  const { pay, online } = usePay();
  const { pay: payCopy, common } = useCopy();
  const ui = payCopy.review;
  const rate = fx?.usdtZar ?? null;
  const person = session?.address;
  const [payees, setPayees] = useState<BillPayee[] | null>(null);
  const [chosen, setChosen] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BillKind>("lawyer");
  const [wallet, setWallet] = useState("");
  const [payeeRef, setPayeeRef] = useState("");
  const [save, setSave] = useState(true);
  const [currency, setCurrency] = useState<"zar" | "usdt">("zar");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [invoice, setInvoice] = useState<InvoiceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; message: string } | null>(null);
  const [errors, setErrors] = useState<{ name?: string; wallet?: string; amount?: string }>({});
  const [done, setDone] = useState(false);
  const [bills, setBills] = useState<PaidBill[] | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reading = useRef(0);

  // A different person or service: forget the old lists and choice (adjusted during render, not in an effect).
  const [seen, setSeen] = useState({ service, person });
  if (seen.service !== service || seen.person !== person) {
    setSeen({ service, person });
    setPayees(null); setChosen(null); setBills(null);
  }

  useEffect(() => {
    let alive = true;
    if (!service || !person) return;
    service.billPayees().then((list) => { if (alive) { setPayees(list); setChosen((c) => c ?? (list[0]?.id ?? "new")); } }).catch(() => { if (alive) { setPayees([]); setChosen("new"); } });
    return () => { alive = false; };
  }, [service, person]);

  const loadBills = useCallback(() => {
    if (!service || !person) return;
    service.paidBills().then(setBills).catch(() => setBills([]));
  }, [service, person]);
  useEffect(() => { loadBills(); }, [loadBills]);
  // A bill still pending: look again until the network confirms it (the payment sheet re-checks the payment itself).
  const pendingBills = bills?.some((b) => b.status === "pending" || b.status === "submitted" || b.status === "signing");
  useEffect(() => {
    if (!pendingBills) return;
    const t = window.setInterval(loadBills, 2500);
    return () => window.clearInterval(t);
  }, [pendingBills, loadBills]);

  const payee = chosen && chosen !== "new" ? payees?.find((p) => p.id === chosen) ?? null : null;
  const isNew = chosen === "new";
  const payeeName = payee?.name ?? name.trim();
  const n = parseAmount(amount) ?? Number.NaN;
  const valid = Number.isFinite(n) && n > 0;
  const amountUsdt = !valid ? null : currency === "usdt" ? n : rate ? zarToUsdt(n, rate) : null;
  // How to write it, the unclear-amount words, or what it converts to (N9).
  const amountHelp = amountHint(amount, () => (valid && amountUsdt !== null ? `= ${currency === "zar" ? `R ${n.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : formatUsdtExact(toBase(n))} · ${fmt(copy.converted, { other: currency === "zar" ? formatUsdtExact(toBase(amountUsdt)) : rate ? `R${(n * rate).toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : "" })}` : undefined), { unclear: common.amountUnclear, format: common.amountFormat });
  const comparison: InvoiceComparison | null = invoice?.result && amountUsdt !== null
    ? compareInvoice(invoice.result.reading, { payee: payeeName, amountUsdt, amountZar: currency === "zar" ? n : null, reference: reference.trim() || null }, rate)
    : invoice?.result && !invoice.result.reading.isInvoice ? compareInvoice(invoice.result.reading, { payee: payeeName, amountUsdt: 0, amountZar: null, reference: null }, rate) : null;
  const c = copy.invoice;
  const reset = () => { setProblem(null); setDone(false); };

  const choose = (id: string | "new") => {
    setChosen(id); setErrors({}); reset();
    const p = payees?.find((x) => x.id === id);
    setReference(p?.reference ?? "");
  };

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    e.target.value = ""; // so the same file can be picked again
    if (!f || !service) return;
    reset();
    const checked = await checkEvidence(f);
    if ("problem" in checked) { setProblem({ code: "file", message: checked.problem === "FileSize" ? c.fileTooBig : c.fileType }); return; }
    const file = checked.file;
    const ticket = ++reading.current;
    setInvoice({ file, status: "reading" });
    try {
      const result = await service.readInvoice(file);
      if (ticket === reading.current) setInvoice({ file, status: "done", result });
    } catch {
      if (ticket === reading.current) setInvoice({ file, status: "error" });
    }
  };

  // Fills in what the invoice says: the person asked for it, and still approves in the review.
  const applyInvoice = () => {
    const r = invoice?.result?.reading;
    if (!r) return;
    if (r.amount !== null && (r.currency === "ZAR" || r.currency === null)) { setCurrency("zar"); setAmount(amountText(r.amount)); }
    else if (r.amount !== null && (r.currency === "USD" || r.currency === "USDT")) { setCurrency("usdt"); setAmount(amountText(r.amount)); }
    if (r.reference) setReference(r.reference);
    if (isNew && r.payeeName && !name.trim()) setName(r.payeeName);
    setErrors({});
  };

  const review = async () => {
    if (!service || busy) return; // one request at a time: no double-submit
    reset();
    const dest = payee?.wallet ?? wallet.trim();
    const errs: typeof errors = {
      name: payeeName ? undefined : copy.nameError,
      wallet: dest ? undefined : copy.addressError,
      amount: !valid ? (amount.trim() && Number.isNaN(n) ? common.amountUnclear : copy.amountError) : amountUsdt === null ? copy.noRate : undefined,
    };
    setErrors(errs);
    if (errs.name || errs.wallet || errs.amount || amountUsdt === null) return;
    setBusy(true);
    try {
      if (isNew) {
        const parsed = billPayeeInputSchema.safeParse({ name: payeeName, wallet: dest, kind, reference: payeeRef });
        if (!parsed.success) { setErrors({ wallet: copy.addressError }); setBusy(false); return; }
        if (save) {
          const saved = await service.saveBillPayee(parsed.data);
          setPayees((list) => [...(list ?? []).filter((p) => p.id !== saved.id), saved]);
          setChosen(saved.id);
        }
      }
      const bill: BillDetails = {
        payee: payeeName, kind: payee?.kind ?? kind, reference: reference.trim() || null, note: note.trim() || null,
        amountZar: currency === "zar" ? n : null,
        invoiceSha256: invoice?.result?.sha256 ?? null, invoiceCheck: comparison?.status ?? null,
      };
      const r = await service.reviewSend({ to: dest, toLabel: payeeName, amountUsdt, bill });
      setBusy(false);
      // Where the invoice disagrees, the review sheet says so again, first, before the person approves.
      const flagged = (comparison?.issues ?? []).filter((i) => i.level === "mismatch" || i.field === "document").map((i) => issueText(i, c));
      const res = await pay({ kind: r.kind, to: r.to, toLabel: r.toLabel, amount: r.amount, review: { ...r, warnings: [...flagged, ...r.warnings] } });
      if (res.ok) {
        setDone(true); setAmount(""); setReference(payee?.reference ?? ""); setNote(""); setInvoice(null);
        loadBills();
      }
    } catch (e) {
      setProblem(explain(e));
      setBusy(false);
    }
  };

  const chip = "relative flex w-[5.75rem] shrink-0 cursor-pointer flex-col items-center gap-1 rounded-md border p-2 text-center has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]";
  const pill = "flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-small font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]";
  const reading$ = invoice?.result?.reading;

  return (
    <div className="mx-auto max-w-md">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      <p className="mb-4 flex items-center gap-2 rounded-full bg-surface-2 px-4 py-2 text-small"><Wallet className="size-4 text-amber" aria-hidden="true" />{copy.wallet}: <span className="font-semibold tabular-nums">{formatUsdt(walletUsdt)}</span></p>

      <Card>
        <fieldset className="min-w-0">
          <legend className="mb-2 font-semibold">{copy.payees}</legend>
          {payees === null ? (
            <div role="status" className="flex gap-2"><span className="sr-only">{copy.payeesLoading}</span><Skeleton className="h-20 w-20" /><Skeleton className="h-20 w-20" /><Skeleton className="h-20 w-20" /></div>
          ) : (
            <div className="relative -mx-1 flex gap-1 overflow-x-auto px-1 pb-2">
              {payees.map((p) => {
                const Icon = KIND_ICON[p.kind];
                const on = chosen === p.id;
                return (
                  <label key={p.id} className={clsx(chip, on ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface-2")}>
                    <input type="radio" name="bill-to" className="sr-only" checked={on} onChange={() => choose(p.id)} />
                    <span className="grid size-11 place-items-center rounded-full bg-surface-2"><Icon className="size-5" aria-hidden="true" /></span>
                    <span className="line-clamp-2 w-full text-small font-semibold leading-tight">{p.name}</span>
                    <span className="w-full truncate text-[0.7rem] text-ink-2">{copy.kinds[p.kind]}</span>
                  </label>
                );
              })}
              <label className={clsx(chip, isNew ? "border-accent bg-accent-soft" : "border-transparent hover:bg-surface-2")}>
                <input type="radio" name="bill-to" className="sr-only" checked={isNew} onChange={() => choose("new")} />
                <span className="grid size-11 place-items-center rounded-full bg-surface-2"><UserRoundPlus className="size-5" aria-hidden="true" /></span>
                <span className="text-small font-semibold">{copy.newPayee}</span>
              </label>
            </div>
          )}
          {payees?.length === 0 && <p className="text-small text-ink-2">{copy.payeesEmpty}</p>}
        </fieldset>
        {payee && <p className="mt-1 font-mono text-small text-ink-2">{shortAddress(payee.wallet, 6)}</p>}

        {isNew && (
          <div className="mt-3 flex flex-col gap-3">
            <Field label={copy.name} htmlFor="bill-name" hint={copy.nameHint} error={errors.name}>
              <input id="bill-name" value={name} onChange={(e) => { setName(e.target.value); setErrors({}); }} maxLength={64} autoComplete="organization" aria-invalid={!!errors.name} aria-describedby={errors.name ? "bill-name-error" : "bill-name-hint"} className={inputClass} />
            </Field>
            <Field label={copy.kind} htmlFor="bill-kind">
              <select id="bill-kind" value={kind} onChange={(e) => setKind(e.target.value as BillKind)} className={inputClass}>
                {BILL_KINDS.map((k) => <option key={k} value={k}>{copy.kinds[k]}</option>)}
              </select>
            </Field>
            <Field label={copy.address} htmlFor="bill-wallet" hint={copy.addressHint} error={errors.wallet}>
              <input id="bill-wallet" value={wallet} onChange={(e) => { setWallet(e.target.value); setErrors({}); reset(); }} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!errors.wallet} aria-describedby={errors.wallet ? "bill-wallet-error" : "bill-wallet-hint"} className={`${inputClass} font-mono text-small`} />
            </Field>
            <Field label={copy.payeeRef} htmlFor="bill-payee-ref">
              <input id="bill-payee-ref" value={payeeRef} onChange={(e) => setPayeeRef(e.target.value)} maxLength={40} autoComplete="off" className={inputClass} />
            </Field>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-small">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="size-5 shrink-0 accent-[var(--ink)]" />
              {copy.save}
            </label>
          </div>
        )}
        {!isNew && errors.wallet && <p role="alert" className="mt-2 border-l-4 border-ink pl-2 text-small font-semibold text-ink">{errors.wallet}</p>}

        <div className="mt-5 flex flex-col gap-3">
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-small font-semibold">{copy.currency}</legend>
            <div className="flex flex-wrap gap-2">
              {(["zar", "usdt"] as const).map((cur) => (
                <label key={cur} className={clsx(pill, currency === cur ? "border-ink bg-ink text-bg" : "border-line-strong bg-surface hover:bg-surface-2")}>
                  <input type="radio" name="bill-currency" value={cur} checked={currency === cur} onChange={() => { setCurrency(cur); setErrors({}); }} className="sr-only" />
                  {cur === "zar" ? copy.zar : copy.usdt}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label={copy.amount} htmlFor="bill-amount" error={errors.amount} hint={amountHelp}>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3.5 grid place-items-center font-semibold text-ink-2" aria-hidden="true">{currency === "zar" ? "R" : "₮"}</span>
              <input id="bill-amount" value={amount} onChange={(e) => { setAmount(e.target.value); setErrors({}); reset(); }} inputMode="decimal" autoComplete="off" placeholder="0" aria-invalid={!!errors.amount} aria-describedby={errors.amount ? "bill-amount-error" : amountHelp ? "bill-amount-hint" : undefined} className={`${inputClass} pl-9 font-display text-h3 tabular-nums`} />
            </div>
          </Field>
          <Field label={copy.reference} htmlFor="bill-ref" hint={copy.referenceHint}>
            <input id="bill-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={40} autoComplete="off" aria-describedby="bill-ref-hint" className={inputClass} />
          </Field>
          <Field label={copy.note} htmlFor="bill-note">
            <input id="bill-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder={copy.notePlaceholder} autoComplete="off" className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card className="mt-4">
        <h2 className="font-semibold">{c.title}</h2>
        <p className="mt-1 text-small text-ink-2">{c.body}</p>
        <input ref={picker} type="file" accept={EVIDENCE_ACCEPT} tabIndex={-1} aria-hidden="true" className="sr-only" onChange={pickFile} />
        {!invoice ? (
          <Button variant="secondary" className="mt-3" onClick={() => picker.current?.click()}><FileText className="size-4" aria-hidden="true" />{c.choose}</Button>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md border border-line-strong p-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-bg"><FileText className="size-4" aria-hidden="true" /></span>
              <p className="min-w-0 flex-1 truncate text-small font-semibold">{invoice.file.name}</p>
              <button type="button" onClick={() => { reading.current++; setInvoice(null); }} aria-label={c.remove} className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-surface-2"><X className="size-5" aria-hidden="true" /></button>
            </div>
            <div role="status" aria-live="polite">
              {invoice.status === "reading" && <p className="flex items-center gap-2 text-small"><Sparkles className="size-4 animate-pulse-soft text-amber" aria-hidden="true" />{c.reading}</p>}
              {invoice.status === "error" && <p className="text-small font-semibold">{c.error}</p>}
              {invoice.status === "done" && invoice.result && reading$ && (
                <div className="flex flex-col gap-3">
                  <Badge tone={invoice.result.engine === "ai" ? "accent" : "neutral"}><Sparkles className="size-3.5" aria-hidden="true" />{invoice.result.engine === "ai" ? c.engineAi : invoice.result.engine === "demo" ? c.engineDemo : c.engineNone}</Badge>
                  {reading$.isInvoice && reading$.confidence > 0 && (
                    <div>
                      <p className="text-small font-semibold">{c.says}</p>
                      <dl className="mt-1 text-small">
                        {[
                          { k: c.payee, v: reading$.payeeName },
                          { k: c.amount, v: reading$.amount !== null ? (reading$.currency === "ZAR" || !reading$.currency ? `R${reading$.amount.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : `${reading$.amount.toLocaleString("en-ZA")} ${reading$.currency === "other" ? "" : reading$.currency}`) : null },
                          { k: c.reference, v: reading$.reference },
                          { k: c.for, v: reading$.description },
                        ].map((row) => (
                          <div key={row.k} className="flex items-start justify-between gap-4 border-b border-line py-2 last:border-0">
                            <dt className="shrink-0 text-ink-2">{row.k}</dt>
                            <dd className="min-w-0 break-words text-right font-medium">{row.v ?? c.none}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                  {comparison && (
                    <Notice
                      tone={comparison.status === "match" ? "ok" : "warn"}
                      icon={comparison.status === "match" ? undefined : <CircleAlert className="size-5" aria-hidden="true" />}
                      title={comparison.status === "match" ? c.match.title : comparison.status === "mismatch" ? c.mismatch.title : c.unread.title}
                    >
                      {comparison.status === "match" && <p>{c.match.body}</p>}
                      {comparison.status === "mismatch" && <p>{c.mismatch.body}</p>}
                      {comparison.issues.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-4">{comparison.issues.map((i) => <li key={`${i.field}-${i.reason ?? i.level}`}>{issueText(i, c)}</li>)}</ul>}
                      {comparison.status !== "unread" && comparison.issues.length > 0 && <Button small variant="secondary" className="mt-2" onClick={applyInvoice}>{c.useInvoice}</Button>}
                    </Notice>
                  )}
                  {!comparison && reading$.isInvoice && reading$.amount !== null && <Button small variant="secondary" className="self-start" onClick={applyInvoice}>{c.useInvoice}</Button>}
                  {reading$.redFlags.length > 0 && (
                    <div className="text-small">
                      <p className="font-semibold">{c.redFlags}</p>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-2">{reading$.redFlags.map((f) => <li key={f}>{f}</li>)}</ul>
                    </div>
                  )}
                  <p className="break-all font-mono text-[0.7rem] text-ink-2">{fmt(c.hash, { hash: `${invoice.result.sha256.slice(0, 16)}…` })}</p>
                </div>
              )}
            </div>
            {invoice.status !== "reading" && <Button small variant="quiet" className="self-start" onClick={() => picker.current?.click()}>{c.change}</Button>}
          </div>
        )}
      </Card>

      {problem && (
        <Notice tone="danger" icon={<CircleAlert className="size-5" aria-hidden="true" />} title={copy.problem} className="mt-4">
          <p role="alert">{problem.message}</p>
          {problem.code === "InvalidAddress" && <Button small variant="secondary" className="mt-2" onClick={() => { setChosen("new"); setProblem(null); window.setTimeout(() => document.getElementById("bill-wallet")?.focus(), 0); }}>{copy.fixAddress}</Button>}
        </Notice>
      )}
      {done && <Notice tone="ok" className="mt-4"><p role="status">{copy.done}</p></Notice>}

      <Button block className="mt-4 min-h-13!" loading={busy} disabled={!online || !service} onClick={review}>{busy ? copy.reviewing : copy.review}{!busy && <ArrowRight className="size-5" aria-hidden="true" />}</Button>
      <p className="mt-3 text-center text-[0.75rem] text-ink-2">{copy.trust}</p>

      <Card className="mt-6">
        <h2 className="flex items-center gap-2 font-semibold"><Banknote className="size-5 text-amber" aria-hidden="true" />{copy.paid.title}</h2>
        {bills === null ? (
          <div role="status" className="mt-3"><span className="sr-only">{copy.paid.loading}</span><Skeleton className="h-14 w-full" /></div>
        ) : bills.length === 0 ? (
          <p className="mt-2 text-small text-ink-2">{copy.paid.empty}</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {bills.map((b) => {
              const status = b.status === "confirmed" ? "confirmed" : b.status === "failed" || b.status === "cancelled" ? "failed" : "pending";
              return (
                <li key={b.id} className="flex flex-col gap-1 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words font-semibold">{b.bill.payee}</p>
                    <p className="shrink-0 font-semibold tabular-nums">{formatUsdt(b.amount)}</p>
                  </div>
                  <p className="break-words text-small text-ink-2">
                    {[b.bill.note, b.bill.reference ? fmt(copy.paid.ref, { ref: b.bill.reference }) : null, b.bill.amountZar ? `R${b.bill.amountZar.toLocaleString("en-ZA")}` : null].filter(Boolean).join(" · ")}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={status === "confirmed" ? "ok" : status === "failed" ? "danger" : "warn"}>{copy.paid.status[status]}</Badge>
                    {b.bill.invoiceSha256 && <Badge tone="neutral">{copy.paid.checkedInvoice}{b.bill.invoiceCheck === "mismatch" ? ` · ${ui.invoiceMismatch}` : ""}</Badge>}
                    {b.signature && <ExplorerLink signature={b.signature} label={payCopy.confirmed.receipt} srLabel={payCopy.confirmed.receiptSr} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="mt-4 text-small text-ink-2">{copy.vaultNote}</p>
      <ButtonLink href="/send" variant="quiet" small className="mt-3">{copy.toSend}</ButtonLink>
    </div>
  );
}
