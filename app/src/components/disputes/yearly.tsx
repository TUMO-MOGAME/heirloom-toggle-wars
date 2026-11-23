"use client";
/**
 * Yearly caps on a rule (added 15 Nov 2026). `YearlyUsage`: "x of y used this year" with a meter and the restart date.
 * `YearlyCapEditor`: the owner sets or changes the cap while the estate is active (the program enforces the bounds).
 */
import { useId, useState, type FormEvent } from "react";
import type { Rule } from "@/lib/types";
import { currentPeriod } from "@/lib/disputes/types";
import { formatUsdt, formatUsdtExact, fromBase, toBase } from "@/lib/format";
import { amountHint, amountText, parseAmount } from "@/lib/amount";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, Field, inputClass, Meter } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { ActionResult, useAction } from "@/components/guardians/parts";

const longDate = (secs: number) => new Date(secs * 1000).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });

/** "1,500 of 3,000 USD₮ used this year" for a rule with a yearly cap; nothing otherwise. */
export function YearlyUsage({ rule, now, category }: { rule: Rule; now: number | null; category: string }) {
  const { disputes: c } = useCopy();
  const y = rule.yearlyCap;
  if (!y) return null;
  const p = now === null ? y : currentPeriod(y.cap, y.periodStart, y.spent, now);
  const used = p.cap > BigInt(0) ? Number(p.spent) / Number(p.cap) : 0;
  return (
    <div className="mt-3">
      <Meter value={used} label={fmt(c.yearly.meter, { category })} tone={used >= 1 ? "brass" : "accent"} />
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-small">
        <span className="tabular-nums">{fmt(c.yearly.used, { spent: formatUsdt(p.spent, { decimals: 0 }).replace(" USD₮", ""), cap: formatUsdt(p.cap, { decimals: 0 }) })}</span>
        <span className="text-ink-2">{fmt(c.yearly.resets, { date: longDate(p.periodEnd) })}</span>
      </div>
    </div>
  );
}

/** Owner, estate Active: set or change a rule's yearly cap. */
export function YearlyCapEditor({ rule, category }: { rule: Rule; category: string }) {
  const { disputes: c, common } = useCopy();
  const { snap, session } = useEstate();
  const id = useId();
  const { act, busy, receipt, refusal } = useAction();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!snap || snap.estate.status !== "Active" || session?.address !== snap.estate.owner) return null;
  const y = c.yearly;
  const min = Math.max(1, Math.ceil(fromBase(rule.recurringAmount)));
  const max = Math.floor(fromBase(rule.lifetimeCap));
  const bounds = { min: formatUsdt(BigInt(min) * BigInt(1_000_000), { decimals: 0 }), max: formatUsdt(rule.lifetimeCap, { decimals: 0 }) };
  const key = `yearcap-${rule.address}`;

  if (!open) {
    return (
      <>
        <Button variant="quiet" small className="mt-2" onClick={() => { setValue(rule.yearlyCap ? amountText(fromBase(rule.yearlyCap.cap)) : ""); setOpen(true); }}>
          {rule.yearlyCap ? y.change : y.set}
        </Button>
        <ActionResult receipt={receipt} refusal={refusal} />
      </>
    );
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const n = parseAmount(value) ?? Number.NaN;
    if (!Number.isFinite(n) || n < min || n > max) { setError(fmt(y.invalid, bounds)); return; }
    setError(null);
    const res = await act(key, (s, est) => s.setYearlyCap(est, rule.address, { capUsdt: n }), y.done);
    if (res.ok) setOpen(false);
  };

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3 rounded-md border-2 border-ink bg-surface p-3">
      <div>
        <p className="font-semibold">{fmt(y.formTitle, { category })}</p>
        <p className="text-small text-ink-2">{y.formBody}</p>
      </div>
      <Field label={y.label} htmlFor={`${id}-cap`} hint={`${amountHint(value, (x) => (x > 0 ? `= ${formatUsdtExact(toBase(x))}` : undefined), { unclear: common.amountUnclear, format: common.amountFormat }) ?? ""} · ${fmt(y.hint, bounds)}`.replace(/^ · /, "")} error={error}>
        <input id={`${id}-cap`} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => { setValue(e.target.value); setError(null); }}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-cap-error` : `${id}-cap-hint`} className={inputClass} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => { setOpen(false); setError(null); }}>{y.cancel}</Button>
        <Button type="submit" className="flex-1" loading={busy === key}>{y.save}</Button>
      </div>
      <ActionResult receipt={receipt} refusal={refusal} />
    </form>
  );
}

/** "1,200 USD₮ left this year" under a rule with a yearly cap (claim wizard); nothing otherwise. */
export function YearlyLeft({ rule, className }: { rule: Rule; className?: string }) {
  const { disputes: c } = useCopy();
  const now = useNow(60_000);
  if (!rule.yearlyCap || now === null) return null;
  const p = currentPeriod(rule.yearlyCap.cap, rule.yearlyCap.periodStart, rule.yearlyCap.spent, now);
  const left = p.cap > p.spent ? p.cap - p.spent : BigInt(0);
  return <span className={className}>{fmt(c.yearly.claimLeft, { cap: formatUsdt(p.cap, { decimals: 0 }), left: formatUsdt(left, { decimals: 0 }) })}</span>;
}
