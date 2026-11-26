"use client";
/**
 * The chip-in QR code (plan §21): pick an amount, get a Solana Pay transaction-request code for it and an
 * "Open in a wallet" link. Shared by the owner's card on the Vault screen and the public page /chip-in/<estate>.
 * Each amount gets a fresh reference, so one code can be found on its own. The QR library loads only when shown.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Smartphone } from "@/components/ui/icons";
import { Field, inputClass } from "@/components/ui/primitives";
import { fmt } from "@/components/shell/copy";
import type { ChipInCopy } from "@/content/chipin";
import { formatUsdtExact } from "@/lib/format";
import { CHIP_IN_PRESETS, checkChipInAmount, chipInApiUrl, newReference, solanaPayUrl, type AmountCheck } from "@/lib/chipin/link";
import { qrPath } from "@/lib/chipin/qr-path";

type Copy = ChipInCopy["card"];

export function amountProblem(check: AmountCheck, c: Copy): string | null {
  if (check.ok) return null;
  return check.code === "amount_too_big" ? c.amountTooBig : check.code === "amount_unclear" ? c.amountUnclear : c.amountZero;
}

/** The QR code itself: dark modules on a light square in both themes (phone cameras read it that way). */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const [shape, setShape] = useState<{ path: string; viewBox: string; value: string } | null>(null);
  useEffect(() => {
    let live = true;
    void import("qrcode").then((q) => {
      if (live) setShape({ ...qrPath(q.create(value, { errorCorrectionLevel: "M" }).modules), value });
    });
    return () => { live = false; };
  }, [value]);
  const ready = shape?.value === value;
  return (
    <div className={clsx("aspect-square w-full max-w-64 rounded-md bg-qr-paper", className)} role="img" aria-label={label}>
      {ready && (
        <svg viewBox={shape.viewBox} className="size-full" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
          <path d={shape.path} className="fill-qr-ink" />
        </svg>
      )}
    </div>
  );
}

export interface ChipInChoice { check: AmountCheck; solanaUrl: string | null; reference: string }

/**
 * The amount picker and the code. `onChange` hears the current choice (the owner's card uses the amount for the demo's
 * simulated chip-in). `origin`: this site's, from the browser (empty until mounted, so nothing renders on the server).
 */
export function ChipInCode({ estate, origin, copy: c, idPrefix, onChange }: { estate: string; origin: string; copy: Copy; idPrefix: string; onChange?: (choice: ChipInChoice) => void }) {
  const [preset, setPreset] = useState<number | null>(50);
  const [other, setOther] = useState("");
  const text = preset !== null ? String(preset) : other;
  const check = useMemo(() => checkChipInAmount(text), [text]);
  // A fresh reference for every amount shown (made in the browser, never sent anywhere but in the link).
  const reference = useMemo(() => (check.ok ? newReference() : ""), [check]);
  const solanaUrl = useMemo(() => {
    if (!origin || !check.ok) return null;
    try { return solanaPayUrl(chipInApiUrl(origin, estate, { amount: String(check.usdt), reference })); } catch { return null; }
  }, [origin, check, estate, reference]);
  useEffect(() => { onChange?.({ check, solanaUrl, reference }); }, [onChange, check, solanaUrl, reference]);
  const problem = preset === null && other.trim() ? amountProblem(check, c) : null;

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div role="group" aria-label={c.amounts} className="flex flex-wrap gap-2">
          {CHIP_IN_PRESETS.map((n) => (
            <button
              key={n} type="button" aria-pressed={preset === n} onClick={() => setPreset(n)}
              className={clsx("min-h-11 rounded-full border-[1.5px] px-4 text-small font-semibold tabular-nums", preset === n ? "border-ink bg-ink text-bg" : "border-line-strong/70 text-ink hover:bg-surface-2")}
            >
              {n} USD₮
            </button>
          ))}
          <button
            type="button" aria-pressed={preset === null} onClick={() => setPreset(null)}
            className={clsx("min-h-11 rounded-full border-[1.5px] px-4 text-small font-semibold", preset === null ? "border-ink bg-ink text-bg" : "border-line-strong/70 text-ink hover:bg-surface-2")}
          >
            {c.other}
          </button>
        </div>
        {preset === null && (
          <Field label={c.otherLabel} htmlFor={`${idPrefix}-other`} hint={c.otherHint} error={problem}>
            <input
              id={`${idPrefix}-other`} inputMode="decimal" autoComplete="off" placeholder="0" value={other}
              onChange={(ev) => setOther(ev.target.value)}
              aria-invalid={!!problem} aria-describedby={problem ? `${idPrefix}-other-error` : `${idPrefix}-other-hint`}
              className={`${inputClass} tabular-nums`}
            />
          </Field>
        )}
        {solanaUrl && (
          <a
            href={solanaUrl}
            className="inline-flex min-h-11 w-fit items-center justify-center gap-2 rounded-full border-[1.5px] border-ink bg-ink px-5 text-[0.9375rem] font-semibold text-bg hover:border-ink-hover hover:bg-ink-hover"
          >
            <Smartphone className="size-4" aria-hidden="true" />{c.openWallet}
          </a>
        )}
      </div>
      <div className="mx-auto w-full max-w-56 shrink-0 sm:mx-0">
        {solanaUrl && check.ok
          ? <QrCode value={solanaUrl} label={fmt(c.qrAlt, { amount: formatUsdtExact(check.base) })} />
          : <div className="aspect-square w-full rounded-md border border-dashed border-line-strong" aria-hidden="true" />}
      </div>
    </div>
  );
}
