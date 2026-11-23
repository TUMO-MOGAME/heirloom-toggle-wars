"use client";
/** Small pieces shared by the guardians screens: data access, the service, waits, countdowns, receipts, "Paused". */
import { useState, type ReactNode } from "react";
import { Pause } from "@/components/ui/icons";
import type { HeirloomService } from "@/lib/service";
import type { Base58 } from "@/lib/types";
import { useEstate, type RunResult } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { ExplorerLink } from "@/components/ui/primitives";
import { Blocked } from "@/components/shell/blocked";
import { fmt, useCopy } from "@/components/shell/copy";
import { guardiansOf, pausedBy, shortName, waitUnit } from "./derive";

/** The guardians part of the current snapshot (null for estates without a Guard). */
export function useGuardians() {
  const { snap } = useEstate();
  return guardiansOf(snap);
}

/** "90 days", "2 minutes", "60 seconds". */
export function useWaitText() {
  const { guardians: c } = useCopy();
  return (secs: number) => { const w = waitUnit(secs); return fmt(c.wait[w.unit], { n: w.n }); };
}

/** Pulls a transaction signature out of what a write returned (a TxResult, { tx }, or a list of them). */
export function signatureOf(v: unknown): string | null {
  if (Array.isArray(v)) return signatureOf(v[v.length - 1]);
  if (!v || typeof v !== "object") return null;
  const o = v as { signature?: unknown; tx?: { signature?: unknown } };
  if (typeof o.signature === "string") return o.signature;
  if (typeof o.tx?.signature === "string") return o.tx.signature;
  return null;
}

/**
 * A write with its result shown in place: the receipt after success, or the contract's refusal (Blocked) in plain
 * words. Busy state and the refresh come from the shared `run()`.
 */
export function useAction() {
  const { run, busy } = useEstate();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const act = async <T,>(key: string, fn: (svc: HeirloomService, estate: string) => Promise<T>, success?: string): Promise<RunResult<T>> => {
    setRefusal(null);
    const res = await run(key, fn, success, true);
    if (res.ok) setReceipt(signatureOf(res.value));
    else setRefusal({ code: res.code, message: res.message });
    return res;
  };
  return { act, busy, receipt, refusal, clear: () => { setReceipt(null); setRefusal(null); } };
}

/** The refusal and the receipt of the last action, if any. */
export function ActionResult({ receipt, refusal, children }: { receipt: string | null; refusal: { code: string; message: string } | null; children?: ReactNode }) {
  const { guardians: c } = useCopy();
  if (refusal) return <div className="mt-3"><Blocked code={refusal.code} message={refusal.message}>{children}</Blocked></div>;
  if (receipt) return <ExplorerLink signature={receipt} label={c.receipt} srLabel={c.receiptSr} className="mt-1" />;
  return null;
}

/** "Paused: Aunt Zodwa raised an objection." Shown on any claim, sale, unlock or succession with an open objection. */
export function PausedNotice({ target, className }: { target: Base58; className?: string }) {
  const { guardians: c } = useCopy();
  const g = useGuardians();
  const now = useNow(5000);
  const o = pausedBy(g, target, now);
  if (!o) return null;
  return (
    <p role="status" className={`flex items-center gap-2 rounded-md border-[1.5px] border-dashed border-ink bg-surface px-3 py-2 text-small font-semibold ${className ?? ""}`}>
      <Pause className="size-4 shrink-0" aria-hidden="true" />
      {fmt(c.succession.paused, { name: shortName(o.monitorName) })}
    </p>
  );
}

/** A ring that fills as a wait runs out. Decorative: the time is also given in text. */
export function CountdownRing({ fraction }: { fraction: number }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="size-14 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ink)" strokeWidth="6" strokeDasharray={circ} strokeDashoffset={circ * (1 - Math.min(1, Math.max(0, fraction)))} className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000" />
    </svg>
  );
}
