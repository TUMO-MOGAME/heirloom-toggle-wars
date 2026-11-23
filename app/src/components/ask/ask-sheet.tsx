"use client";
/**
 * "Ask for money": one short form in a sheet (bottom sheet on phones). What it is for, how much (rand or USD₮, the
 * other shown beside it), which approved payee, and an optional letter for the agent to check. The same cap checks
 * the program makes are shown before anything is signed; the program still makes them (a refusal shows in place).
 * Opened through the estate intent `{ kind: "ask" }` (chat composer, chat home card, Claims screen).
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Check, HandCoins } from "@/components/ui/icons";
import { ask as askEnglish, type AskCopy } from "@/content/ask";
import { useLocalized } from "@/lib/i18n/client";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { formatUsdt, formatUsdtExact, formatZar, toBase } from "@/lib/format";
import { amountUsdt, askOptions, checkAsk, decider, optionKey, parseAmount, type AskOption } from "@/lib/ask/logic";
import { cleanPurpose, PURPOSE_MAX, type AskCurrency } from "@/lib/ask/types";
import type { AgentReport } from "@/lib/types";
import { FilePicker, Sheet } from "@/components/ui/client";
import { Button, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { ReportCard } from "@/components/agent/report-card";
import { Blocked } from "@/components/shell/blocked";
import { fmt, useCopy } from "@/components/shell/copy";

export function AskSheet() {
  const { intent, setIntent, snap } = useEstate();
  const c = useLocalized(askEnglish, (t) => t.ask);
  const [open, setOpen] = useState<{ rule?: string; n: number } | null>(null);

  useEffect(() => {
    if (intent?.kind !== "ask") return;
    // Consumes the one-off intent (an external event), then clears it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen((o) => ({ rule: intent.rule, n: (o?.n ?? 0) + 1 }));
    setIntent(null);
  }, [intent, setIntent]);

  const owner = snap ? snap.estate.ownerName.split(" ")[0] : "";
  const trusted = snap?.estate.status === "Unlocked";
  return (
    <Sheet open={!!open} onClose={() => setOpen(null)} title={c.sheet.title} description={snap ? fmt(trusted ? c.sheet.descTrusted : c.sheet.descOwner, { owner }) : undefined} closeLabel={c.sheet.close}>
      {open && snap && <AskForm key={open.n} c={c} preset={open.rule} onClose={() => setOpen(null)} />}
    </Sheet>
  );
}

function AskForm({ c, preset, onClose }: { c: AskCopy; preset?: string; onClose: () => void }) {
  const { common } = useCopy();
  const { snap, session, fx, run, isMock } = useEstate();
  const now = useNow(30_000);
  const ids = useId();
  const rate = fx?.usdtZar ?? null;
  const s = c.sheet;
  const options = useMemo(() => (snap && now !== null ? askOptions(snap, session?.address, now) : []), [snap, session?.address, now]);
  const [purpose, setPurpose] = useState("");
  const [currency, setCurrency] = useState<AskCurrency>(rate ? "ZAR" : "USDT");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<{ field: "purpose" | "amount" | "form"; text: string } | null>(null);
  const [blocked, setBlocked] = useState<{ code: string; message: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ report: AgentReport; attachment: boolean } | null>(null);

  if (!snap || now === null) return null;
  const e = snap.estate;
  const owner = e.ownerName.split(" ")[0];

  if (options.length === 0) {
    return (
      <Notice tone="warn" title={s.none}>
        <p>{fmt(e.status === "Active" ? s.noneActive : s.nonePaused, { owner })}</p>
      </Notice>
    );
  }

  const option: AskOption = options.find((o) => optionKey(o) === picked)
    ?? (preset ? options.find((o) => o.rule.address === preset) : undefined) ?? options[0];
  const typed = parseAmount(text);
  const usdt = amountUsdt(typed, currency, rate);
  const base = usdt ? toBase(usdt) : BigInt(0);
  const problem = usdt ? checkAsk(option, base) : null;
  const money = (b: bigint) => (currency === "ZAR" && rate ? formatZar(b, rate) : formatUsdt(b, { decimals: 0 }));
  const other = usdt ? (currency === "ZAR" ? formatUsdt(base) : rate ? formatZar(base, rate) : "") : "";
  const who = decider(e, option.rule);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const p = cleanPurpose(purpose);
    if (!p) { setError({ field: "purpose", text: s.purposeError }); return; }
    if (usdt === null) { setError({ field: "amount", text: s.noRate }); return; }
    if (!usdt || !(typed > 0)) { setError({ field: "amount", text: s.amountError }); return; }
    if (problem) return;
    if (!consent) { setError({ field: "form", text: common.consentRequired }); return; }
    setError(null); setBlocked(null); setSending(true);
    const res = await run("ask", (svc, est) => svc.askForMoney(est, {
      rule: option.rule.address, payee: option.payee.wallet, amountUsdt: usdt, purpose: p, currency, typed, evidence: file,
    }), undefined, true);
    setSending(false);
    if (res.ok) setResult({ report: res.value.report, attachment: !!file });
    else setBlocked({ code: res.code, message: res.message });
  };

  if (result) {
    const ok = result.report.verdict !== "reject";
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className={clsx("grid size-11 shrink-0 place-items-center rounded-full", ok ? "bg-ok-soft text-ok" : "bg-ink text-bg")}>
            {ok ? <Check className="size-5" /> : <HandCoins className="size-5" />}
          </span>
          <div className="min-w-0">
            <p role="status" className="text-h3 font-semibold">{ok ? fmt(who === "owner" ? c.result.sentOwner : c.result.sentTrusted, { owner }) : c.result.refused}</p>
            <p className="mt-1 text-ink-2">{ok ? fmt(who === "owner" ? c.result.bodyOwner : c.result.bodyTrusted, { owner }) : c.result.refusedBody}</p>
            {ok && !result.attachment && <p className="mt-1 text-small text-ink-2">{c.result.noDoc}</p>}
          </div>
        </div>
        {result.attachment && <ReportCard report={result.report} compact />}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose}>{c.result.done}</Button>
          <Button variant="secondary" onClick={() => { setResult(null); setText(""); setPurpose(""); setFile(null); setConsent(false); }}>{c.result.another}</Button>
        </div>
      </div>
    );
  }

  const purposeId = `${ids}-purpose`;
  const amountId = `${ids}-amount`;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Field label={s.purposeLabel} htmlFor={purposeId} hint={s.purposeHint} error={error?.field === "purpose" ? error.text : null}>
          <input
            id={purposeId} value={purpose} maxLength={PURPOSE_MAX} autoComplete="off" enterKeyHint="next"
            onChange={(ev) => { setPurpose(ev.target.value); if (error?.field === "purpose") setError(null); }}
            aria-invalid={error?.field === "purpose"} aria-describedby={error?.field === "purpose" ? `${purposeId}-error` : `${purposeId}-hint`}
            className={inputClass}
          />
        </Field>
        <div role="group" aria-label={s.ideasLabel} className="flex flex-wrap gap-1.5">
          {s.ideas.map((idea) => (
            <button key={idea} type="button" onClick={() => { setPurpose(idea); setError(null); }} aria-pressed={purpose === idea}
              className={clsx("min-h-11 rounded-full border px-3.5 text-small font-medium", purpose === idea ? "border-ink bg-ink text-bg" : "border-line-strong bg-surface hover:bg-surface-2")}>
              {idea}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <fieldset>
          <legend className="mb-1.5 text-small font-semibold">{s.currencyLabel}</legend>
          <div className="inline-flex rounded-full border border-line-strong p-1">
            {(["ZAR", "USDT"] as const).map((cur) => (
              <label key={cur} className={clsx("flex min-h-11 min-w-20 cursor-pointer items-center justify-center rounded-full px-4 text-small font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]", currency === cur ? "bg-ink text-bg" : "text-ink hover:bg-surface-2", cur === "ZAR" && !rate && "cursor-not-allowed opacity-50")}>
                <input type="radio" name={`${ids}-currency`} value={cur} checked={currency === cur} disabled={cur === "ZAR" && !rate} onChange={() => { setCurrency(cur); setError(null); }} className="sr-only" />
                {cur === "ZAR" ? s.rand : s.usdt}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={s.amountLabel} htmlFor={amountId} error={error?.field === "amount" ? error.text : null}>
          <div className="relative">
            {currency === "ZAR" && <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-display text-h2 text-ink-2">R</span>}
            <input
              id={amountId} inputMode="decimal" autoComplete="off" placeholder="0" value={text}
              onChange={(ev) => { setText(ev.target.value); setBlocked(null); if (error?.field === "amount") setError(null); }}
              aria-invalid={error?.field === "amount" || !!problem} aria-describedby={`${amountId}-about${error?.field === "amount" ? ` ${amountId}-error` : ""}${problem ? ` ${amountId}-problem` : ""}`}
              className={clsx(inputClass, "min-h-16 font-display text-h2 tabular-nums", currency === "ZAR" ? "pl-10" : "pr-20")}
            />
            {currency === "USDT" && <span aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-ink-2">USD₮</span>}
          </div>
        </Field>
        <p id={`${amountId}-about`} className="text-small text-ink-2" aria-live="polite">{other ? `= ${currency === "ZAR" ? `R ${typed.toLocaleString("en-ZA", { maximumFractionDigits: 2 })}` : formatUsdtExact(base)} · ${fmt(s.about, { amount: other })}` : text.trim() && Number.isNaN(typed) ? common.amountUnclear : common.amountFormat}</p>
      </div>

      <fieldset>
        <legend className="mb-1 text-small font-semibold">{s.payeeLabel}</legend>
        <p className="mb-2 text-small text-ink-2">{s.payeeHint}</p>
        <div className="grid gap-2">
          {options.map((o) => {
            const k = optionKey(o);
            const on = optionKey(option) === k;
            return (
              <label key={k} className={clsx("flex min-h-14 cursor-pointer items-center gap-3 rounded-md border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--focus)]", on ? "border-accent bg-accent-soft" : "border-line-strong")}>
                <input type="radio" name={`${ids}-payee`} className="sr-only" checked={on} onChange={() => { setPicked(k); setBlocked(null); }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{o.own ? s.ownWallet : o.payee.name}</span>
                  <span className="block text-small text-ink-2">
                    {common.status.category[o.rule.category]} · {fmt(s.limits, { max: money(o.rule.maxPerClaim), left: money(o.left) })}
                    {o.yearLeft !== null && <> · {fmt(s.yearLeft, { amount: money(o.yearLeft) })}</>}
                  </span>
                </span>
                {on && <Check className="size-5 shrink-0 text-amber" aria-hidden="true" />}
              </label>
            );
          })}
        </div>
      </fieldset>

      {problem && problem.code !== "InvalidAmount" && (
        <Notice tone="warn">
          <p id={`${amountId}-problem`} role="status" className="font-semibold">{fmt(s.over[problem.code], { limit: money(problem.limit) })}</p>
          <p className="text-small">{s.overNote}</p>
        </Notice>
      )}
      {!problem && base > BigInt(0) && base > e.vaultBalance && (
        <Notice tone="accent"><p role="status" className="text-small">{fmt(s.vaultLow, { vault: money(e.vaultBalance) })}</p></Notice>
      )}

      <FilePicker id={`${ids}-file`} label={s.attachLabel} hint={s.attachHint} file={file} onFile={(f) => { setFile(f); setBlocked(null); }} samples={isMock ? s.samples : undefined} copy={common.file} />
      {file && <Button small variant="ghost" className="-mt-3 self-start" onClick={() => setFile(null)}>{s.removeFile}</Button>}
      <Consent id={`${ids}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
      {error?.field === "form" && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error.text}</p>}
      {blocked && <Blocked code={blocked.code} message={blocked.message} />}
      <Button type="submit" block loading={sending} disabled={!!problem && problem.code !== "InvalidAmount"}>
        <HandCoins className="size-5" aria-hidden="true" />{sending ? s.sending : s.submit}
      </Button>
    </form>
  );
}
