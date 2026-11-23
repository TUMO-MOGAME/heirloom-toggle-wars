"use client";
/**
 * The owner's letters, grouped by who they are for: occasion, state ("Opens when the estate unlocks", "Opens with
 * Naledi's gift, 500 USD₮, due 14 Aug 2029", "Opened …"), and Read, Edit and Delete. An opened letter can no longer
 * be edited; nothing changes once the estate is sealed or while a passing is confirmed.
 */
import { BookOpen, Clock, HandHeart, Mail, Pencil, Trash2 } from "@/components/ui/icons";
import { Button, EmptyState } from "@/components/ui/primitives";
import type { EstateSnapshot } from "@/lib/service";
import type { Locale } from "@/lib/i18n/locales";
import type { LetterView } from "@/lib/letters/types";
import { fill, letterWords, nameOf, stateText, type Copy } from "./words";

export function LetterList({
  letters, snap, copy, locale, locked, onRead, onEdit, onDelete,
}: {
  letters: LetterView[]; snap: EstateSnapshot; copy: Copy; locale: Locale; locked: boolean;
  onRead: (l: LetterView) => void; onEdit: (l: LetterView) => void; onDelete: (l: LetterView) => void;
}) {
  if (!letters.length) return <EmptyState icon={<Mail className="size-6" aria-hidden="true" />} title={copy.list.empty} />;
  const groups = new Map<string, LetterView[]>();
  for (const l of [...letters].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const k = l.to.kind === "family" ? "family" : l.to.wallet;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const order = ["family", ...snap.beneficiaries.map((b) => b.wallet)].filter((k) => groups.has(k));
  for (const k of groups.keys()) if (!order.includes(k)) order.push(k);

  return (
    <div className="grid gap-5">
      {order.map((k) => (
        <section key={k} aria-labelledby={`letters-to-${k}`}>
          <h3 id={`letters-to-${k}`} className="text-small font-semibold uppercase tracking-[0.12em] text-ink-2">
            {fill(copy.list.to, { name: k === "family" ? copy.list.family : nameOf(snap, k) })}
          </h3>
          <ul className="mt-2 grid gap-3">
            {groups.get(k)!.map((l) => {
              const words = letterWords(l, copy);
              const title = words.occasion || copy.list.untitled;
              const gift = l.opens.kind === "payment";
              return (
                <li key={l.id} className="rounded-lg border border-line bg-surface p-4 shadow-card">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{title}</p>
                      <p className="mt-1 inline-flex items-start gap-1.5 text-small text-ink-2" data-state={l.state}>
                        {gift ? <HandHeart className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden="true" /> : <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                        <span>{stateText(l, snap, copy, locale)}</span>
                      </p>
                      {!l.sig && l.demoKey && <p className="mt-1 text-[0.75rem] text-ink-2">{copy.list.seeded}</p>}
                    </div>
                    <div className="-ml-2 flex flex-wrap gap-1.5 sm:ml-0 sm:shrink-0">
                      <Button variant="ghost" small onClick={() => onRead(l)} aria-label={`${copy.read.title}: ${title}`}><BookOpen className="size-4" aria-hidden="true" />{copy.card.read}</Button>
                      {!locked && l.state !== "open" && <Button variant="secondary" small onClick={() => onEdit(l)} aria-label={`${copy.list.edit}: ${title}`}><Pencil className="size-4" aria-hidden="true" />{copy.list.edit}</Button>}
                      {!locked && <Button variant="ghost" small onClick={() => onDelete(l)} aria-label={`${copy.list.delete}: ${title}`}><Trash2 className="size-4" aria-hidden="true" />{copy.list.delete}</Button>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
