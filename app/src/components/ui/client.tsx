"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import clsx from "clsx";
import { Check, FileCheck2, FileUp, X } from "@/components/ui/icons";
import { useEstate } from "@/lib/hooks/estate";
import { useBackClose } from "@/lib/hooks/use-back-close";
import { useChangedSinceMount, useReducedMotion } from "@/lib/hooks/use-reduced-motion";
import { checkEvidence, demoSample, EVIDENCE_ACCEPT, sampleFile, type EvidenceProblem } from "@/lib/evidence";

// The toasts animate out with motion, so their code (and the library) loads only once a first toast exists.
const ToastStack = dynamic(() => import("./toast-stack").then((m) => m.ToastStack), { ssr: false });

/* ---------- Sheet: bottom sheet on phones, side panel on desktop (native <dialog>) ---------- */

export function Sheet({
  open, onClose, title, description, closeLabel, children, footer, tall = false, headerExtra,
}: {
  open: boolean; onClose: () => void; title: string; description?: string; closeLabel: string;
  children: ReactNode; footer?: ReactNode; tall?: boolean; headerExtra?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useBackClose(open, onClose); // Android back closes the sheet first
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { d.showModal(); if (!(document.activeElement instanceof HTMLInputElement)) d.querySelector<HTMLElement>("[data-sheet-title]")?.focus(); }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={clsx("sheet", tall && "sheet-tall")}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <>
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 pb-3 pt-4 sm:px-5">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} data-sheet-title tabIndex={-1} className="text-h3 outline-none">{title}</h2>
              {description && <p className="mt-1 text-small text-ink-2">{description}</p>}
            </div>
            {headerExtra}
            <button type="button" onClick={onClose} aria-label={closeLabel} className="-mr-1.5 -mt-1 grid size-11 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-2">
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          {/* Focusable so keyboard users can scroll a long sheet (e.g. a letter on a phone); WCAG 2.1.1, axe scrollable-region-focusable. */}
          <div role="region" aria-labelledby={titleId} tabIndex={0} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>
          {footer && <div className="shrink-0 border-t border-line bg-surface px-4 pt-3 sm:px-5"><div className="pb-3">{footer}</div></div>}
        </>
      )}
    </dialog>
  );
}

/* ---------- Toaster ---------- */

export function Toaster({ dismissLabel }: { dismissLabel: string }) {
  const { toasts, dismiss } = useEstate();
  // Once a toast has been shown the stack stays mounted, so later toasts (and every exit) animate as before.
  const [used, setUsed] = useState(false);
  if (toasts.length > 0 && !used) setUsed(true);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+var(--safe-b)+0.75rem)] z-[70] flex flex-col items-center gap-2 px-4" aria-live="polite" aria-atomic="false">
      {used && <ToastStack toasts={toasts} dismiss={dismiss} dismissLabel={dismissLabel} />}
    </div>
  );
}

/* ---------- Quorum: dots that fill as trusted people approve ---------- */

export function Quorum({ approvals, needed, names, label }: { approvals: boolean[]; needed: number; names?: readonly string[]; label: string }) {
  const got = approvals.filter(Boolean).length;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" role="group" aria-label={label}>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {approvals.map((on, i) => <QuorumDot key={i} on={on} name={names?.[i]} n={i + 1} />)}
      </div>
      <span className="text-small font-semibold tabular-nums">{label}</span>
      {needed > 0 && got >= needed && <span className="sr-only">✓</span>}
    </div>
  );
}

/** One approval: beats once when it fills (not when the page opens with it already filled). */
function QuorumDot({ on, name, n }: { on: boolean; name?: string; n: number }) {
  const changed = useChangedSinceMount(on);
  return (
    <span
      title={name}
      className={clsx("grid size-7 place-items-center rounded-full border-2 text-[0.7rem] font-bold", on ? "border-ink bg-ink text-bg" : "border-dashed border-line-strong bg-surface text-ink-2", on && changed && "beat")}
    >
      {on ? <Check className="size-4" /> : (name?.replace(/^(Adv\.|Ms\.|Mr\.|Uncle|Aunt|Pastor)\s+/i, "")[0] ?? n)}
    </span>
  );
}

/* ---------- Typewriter: streaming feel for agent replies ---------- */

export function Typewriter({ text, active, onDone, onTick }: { text: string; active: boolean; onDone?: () => void; onTick?: () => void }) {
  const reduced = useReducedMotion();
  const animate = active && !reduced;
  const [n, setN] = useState(animate ? 0 : text.length);
  const done = useRef(!animate);
  useEffect(() => {
    if (!animate) { if (!done.current) { done.current = true; onDone?.(); } return; }
    const step = Math.max(2, Math.round(text.length / 110));
    const id = window.setInterval(() => {
      setN((prev) => {
        const next = Math.min(text.length, prev + step);
        if (next >= text.length) {
          window.clearInterval(id);
          if (!done.current) { done.current = true; window.setTimeout(() => onDone?.(), 0); }
        }
        return next;
      });
      onTick?.();
    }, 22);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, animate]);
  const shown = animate ? n : text.length;
  const typing = shown < text.length;
  return (
    <>
      <span aria-hidden={typing || undefined} className={clsx("whitespace-pre-line", typing && "typing-caret")}>{text.slice(0, shown)}</span>
      {typing && <span className="sr-only">{text}</span>}
    </>
  );
}

/* ---------- File picker with sample documents (so the demo never needs real papers) ---------- */

export interface SampleDoc { label: string; fileName: string }

type FileCopy = { choose: string; change: string; samplesLabel: string; chosen: string; rules: string; loading: string; failed: string; problems: Record<EvidenceProblem, string> };

/**
 * A document for the agent. Every file, chosen or a sample, is checked here first (type, its bytes, at most 4 MB:
 * lib/evidence.ts), so nothing is signed for a file the review would refuse. On a real network only Heirloom's own
 * demo documents are offered as samples, and only where they fit this family; the demo makes small stand-in PDFs.
 */
export function FilePicker({
  id, label, hint, file, onFile, samples, copy, accept = EVIDENCE_ACCEPT,
}: {
  id: string; label: string; hint?: string; file: File | null; onFile: (f: File | null) => void; samples?: readonly SampleDoc[];
  copy: FileCopy;
  accept?: string;
}) {
  const { isMock, snap, session } = useEstate();
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const ticket = useRef(0);
  const who = { owner: snap?.estate.ownerName, me: session?.label };
  const offered = (samples ?? []).map((s) => ({ ...s, url: sampleFile(s.fileName, who) })).filter((s) => isMock || s.url);
  const take = async (pick: () => Promise<File>, key: string | null) => {
    const mine = ++ticket.current;
    setProblem(null); setLoading(key);
    try {
      const r = await checkEvidence(await pick());
      if (mine !== ticket.current) return;
      if ("problem" in r) { setProblem(copy.problems[r.problem]); onFile(null); } else onFile(r.file);
    } catch {
      if (mine === ticket.current) { setProblem(copy.failed); onFile(null); }
    } finally {
      if (mine === ticket.current) setLoading(null);
    }
  };
  const sample = (s: (typeof offered)[number]) => take(async () => {
    if (!s.url) return demoSample(s.fileName, s.label);
    const res = await fetch(s.url);
    if (!res.ok) throw new Error(String(res.status));
    return new File([await res.blob()], s.url.split("/").pop()!, { type: "application/pdf" });
  }, s.fileName);
  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="text-small font-semibold">{label}</span>
      <label
        htmlFor={id}
        className={clsx(
          "flex min-h-20 cursor-pointer items-center gap-3 rounded-md border-2 border-dashed p-3.5 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]",
          file ? "border-solid border-ink bg-surface" : "border-line-strong bg-surface hover:bg-surface-2",
        )}
      >
        <span className={clsx("grid size-11 shrink-0 place-items-center rounded-full", file ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2")}>
          {file ? <FileCheck2 className="size-5" aria-hidden="true" /> : <FileUp className="size-5" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1 text-small">
          <span className="block truncate text-body font-semibold">{file ? file.name : copy.choose}</span>
          <span className="text-ink-2">{file ? copy.change : hint ? `${hint}. ${copy.rules}` : copy.rules}</span>
        </span>
        <input
          id={id}
          type="file"
          accept={accept}
          aria-labelledby={`${id}-label`}
          className="sr-only"
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; if (f) void take(async () => f, null); else onFile(null); }}
        />
      </label>
      <p className="sr-only" role="status">{loading ? copy.loading : file ? `${copy.chosen} ${file.name}` : ""}</p>
      {problem && <p id={`${id}-problem`} role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{problem}</p>}
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-ink-2">{copy.samplesLabel}</span>
          {offered.map((s) => (
            <button
              key={s.fileName}
              type="button"
              disabled={loading !== null}
              aria-busy={loading === s.fileName || undefined}
              onClick={() => void sample(s)}
              className={clsx("min-h-11 rounded-full border px-3.5 text-small font-medium disabled:opacity-60", file?.name === s.fileName || (s.url && file?.name === s.url.split("/").pop()) ? "border-ink bg-ink text-bg" : "border-line-strong bg-surface hover:bg-surface-2")}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
