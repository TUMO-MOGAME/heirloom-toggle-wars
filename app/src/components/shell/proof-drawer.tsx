"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, FileText, Info, ScrollText, TreeDeciduous } from "@/components/ui/icons";
import type { ActivityItem } from "@/lib/types";
import { formatUsdt, shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Sheet } from "@/components/ui/client";
import { ExplorerLink, Notice } from "@/components/ui/primitives";
import { timeAgo, useCopy } from "./copy";
import { ActivityText, useNameBook } from "./activity-text";
import type { NameBook } from "@/lib/people";
import { ReceiptButton } from "@/components/voice/receipt-button";
import type { DemoReceiptSource } from "@/lib/voice/receipts";

const PROGRAM_ID = process.env.NEXT_PUBLIC_HEIRLOOM_PROGRAM_ID ?? "";

export function CopyValue({ value, copyLabel, copiedLabel }: { value: string; copyLabel: string; copiedLabel: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); window.setTimeout(() => setDone(false), 1600); } catch { /* clipboard blocked */ }
      }}
      className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-md text-left font-mono text-small hover:bg-surface-2"
    >
      <span className="truncate">{shortAddress(value, 8)}</span>
      {done ? <Check className="size-4 shrink-0 text-ink" strokeWidth={3} aria-hidden="true" /> : <Copy className="size-4 shrink-0 text-ink-2" aria-hidden="true" />}
      <span className="sr-only" role="status">{done ? copiedLabel : copyLabel}</span>
    </button>
  );
}

/**
 * Activity lines, newest first, each with its receipt (the Proof drawer and the public record share it). Payments
 * also get "Hear it" (a spoken receipt); `receipts` gives the demo the rules and assets its receipt ids name.
 */
export function ActivityList({ items, now, book, receipts }: { items: ActivityItem[]; now: number | null; book: NameBook; receipts?: Omit<DemoReceiptSource, "item"> }) {
  const { common } = useCopy();
  const c = common.proof;
  return (
    <ol className="flex flex-col">
      {items.map((a, i) => (
        <li key={`${a.txSignature}-${i}`} className="border-b border-line py-2.5 last:border-0">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-small font-medium"><ActivityText item={a} book={book} /></p>
            {a.amount !== undefined && <span className="shrink-0 text-small font-semibold tabular-nums">{formatUsdt(a.amount, { decimals: 0 })}</span>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <span className="text-[0.75rem] text-ink-2"><span className="font-mono">{a.kind}</span> · {timeAgo(a.ts, now, common.time)}</span>
            <span className="flex flex-wrap items-center gap-x-2">
              {a.txSignature && <ExplorerLink signature={a.txSignature} label={c.receipt} srLabel={c.receiptSr} />}
              <ReceiptButton item={a} demo={receipts} />
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Every on-chain transaction for this estate, one tap away from any screen. */
export function ProofDrawer() {
  const { common, assistant } = useCopy();
  const c = common.proof;
  const { proofOpen, setProofOpen, snap, isMock, role } = useEstate();
  const now = useNow(15000);
  const book = useNameBook(snap);
  const e = snap?.estate;
  const facts = e ? [
    ...(PROGRAM_ID ? [{ term: c.facts.program, value: PROGRAM_ID }] : []),
    { term: c.facts.estate, value: e.address },
    { term: c.facts.will, value: e.willHash },
    { term: c.facts.mint, value: e.usdtMint },
    { term: c.facts.agent, value: e.agent },
  ] : [];
  return (
    <Sheet open={proofOpen} onClose={() => setProofOpen(false)} title={c.title} description={c.body} closeLabel={c.close} tall>
      <div className="flex flex-col gap-4">
        {isMock && <Notice tone="warn" icon={<Info className="size-5" aria-hidden="true" />}>{c.mockNote}</Notice>}
        {e && (
          <dl className="rounded-lg border border-line bg-surface px-3.5 py-1">
            {facts.map((f) => (
              <div key={f.term} className="flex flex-wrap items-center justify-between gap-x-3 border-b border-line py-1 last:border-0">
                <dt className="text-small text-ink-2">{f.term}</dt>
                <dd className="min-w-0">{f.value ? <CopyValue value={f.value} copyLabel={c.copy} copiedLabel={c.copied} /> : <span className="text-small">{c.notSigned}</span>}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 py-2.5">
              <dt className="text-small text-ink-2">{c.facts.network}</dt>
              <dd className="text-small font-medium">{c.network}</dd>
            </div>
          </dl>
        )}
        {e && (
          <div className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
            <Link href={`/audit/${e.address}`} onClick={() => setProofOpen(false)} className="inline-flex min-h-11 items-center gap-2 font-semibold text-ink underline decoration-1 underline-offset-4 hover:decoration-2">
              <ScrollText className="size-4 shrink-0" aria-hidden="true" />{assistant.publicRecord.link}<ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
            <p className="text-small text-ink-2">{assistant.publicRecord.hint}</p>
            <Link href="/statement" onClick={() => setProofOpen(false)} className="mt-1 inline-flex min-h-11 items-center gap-2 font-semibold text-ink underline decoration-1 underline-offset-4 hover:decoration-2">
              <FileText className="size-4 shrink-0" aria-hidden="true" />{c.statement}<ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
            <p className="text-small text-ink-2">{c.statementHint}</p>
            {role !== "buyer" && (
              <>
                <Link href="/tree" onClick={() => setProofOpen(false)} className="mt-1 inline-flex min-h-11 items-center gap-2 font-semibold text-ink underline decoration-1 underline-offset-4 hover:decoration-2">
                  <TreeDeciduous className="size-4 shrink-0" aria-hidden="true" />{c.tree}<ArrowRight className="size-4 shrink-0" aria-hidden="true" />
                </Link>
                <p className="text-small text-ink-2">{c.treeHint}</p>
              </>
            )}
          </div>
        )}
        {!snap || snap.activity.length === 0 ? (
          <p className="py-8 text-center text-ink-2">{c.empty}</p>
        ) : (
          <ActivityList items={snap.activity} now={now} book={book} receipts={{ estate: snap.estate.address, rules: snap.rules, assets: snap.assets }} />
        )}
      </div>
    </Sheet>
  );
}
