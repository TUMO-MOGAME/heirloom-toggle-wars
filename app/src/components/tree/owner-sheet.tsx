"use client";
/**
 * Owner tools: add a family relationship (person, relationship, person), see the ones you added and remove them.
 * Relationships are personal information and stay off-chain; the consent note links to the privacy policy.
 */
import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { Info, Trash2 } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/client";
import { Button, Consent, Field, Notice, inputClass } from "@/components/ui/primitives";
import type { Relationship, RelationshipInput, RelationshipKind, TreeSnapshot } from "@/lib/tree/types";
import { fill, type Copy } from "./words";

const KINDS: RelationshipKind[] = ["parentOf", "spouseOf", "siblingOf"];

export function RelationshipSheet({
  open, onClose, copy, tree, viewer, busy, onAdd, onRemove,
}: {
  open: boolean; onClose: () => void; copy: Copy; tree: TreeSnapshot; viewer: string | null; busy: string | null;
  onAdd: (input: RelationshipInput) => Promise<boolean>;
  onRemove: (r: Relationship) => void;
}) {
  const id = useId();
  const [from, setFrom] = useState("");
  const [kind, setKind] = useState<RelationshipKind>("parentOf");
  const [to, setTo] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hidden people chose not to be named, so they are not offered here.
  const people = tree.people.filter((p) => !p.hidden && p.name).sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = (pid: string) => tree.people.find((p) => p.id === pid)?.name || copy.person.hidden;
  const mine = tree.relationships.filter((r) => r.declaredBy === viewer);
  const relText = (r: Pick<Relationship, "from" | "kind" | "to">) => fill(copy.owner.preview, { from: nameOf(r.from), kind: copy.owner.kinds[r.kind], to: nameOf(r.to) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to || from === to) { setError(copy.owner.same); return; }
    setError(null);
    if (await onAdd({ from, kind, to })) { setFrom(""); setTo(""); setConsent(false); }
  };

  return (
    <Sheet
      open={open} onClose={onClose} title={copy.owner.sheetTitle} description={copy.owner.sheetBody} closeLabel={copy.card.close}
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{copy.owner.cancel}</Button>
          <Button type="submit" form={`${id}-form`} loading={busy === "tree.add"} disabled={!consent}>{copy.owner.save}</Button>
        </div>
      )}
    >
      <form id={`${id}-form`} onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
        <Notice icon={<Info className="size-5" aria-hidden="true" />}>
          {copy.owner.consentNote}{" "}
          <Link href="/privacy" target="_blank" className="font-semibold text-ink underline underline-offset-4">{copy.owner.consent.link}</Link>
        </Notice>
        <Field label={copy.owner.from} htmlFor={`${id}-from`}>
          <select id={`${id}-from`} value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} required>
            <option value="">{copy.owner.pick}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={copy.owner.kind} htmlFor={`${id}-kind`}>
          <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as RelationshipKind)} className={inputClass}>
            {KINDS.map((k) => <option key={k} value={k}>{copy.relationships[k]}</option>)}
          </select>
        </Field>
        <Field label={copy.owner.to} htmlFor={`${id}-to`} error={error}>
          <select id={`${id}-to`} value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} required aria-invalid={!!error || undefined}>
            <option value="">{copy.owner.pick}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {from && to && from !== to && <p className="font-medium" aria-live="polite">{relText({ from, kind, to })}</p>}
        <Consent id={`${id}-consent`} checked={consent} onChange={setConsent} copy={copy.owner.consent} />
      </form>

      <section aria-labelledby={`${id}-mine`} className="mt-6 border-t border-line pt-4">
        <h3 id={`${id}-mine`} className="font-semibold">{copy.owner.yours}</h3>
        {mine.length === 0 ? <p className="mt-1 text-small text-ink-2">{copy.owner.yoursEmpty}</p> : (
          <ul className="mt-2 grid gap-1.5">
            {mine.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 border-b border-line py-1.5 last:border-0">
                <span className="min-w-0 text-small">{relText(r)}</span>
                <Button
                  variant="ghost" small className="shrink-0" loading={busy === `tree.remove.${r.id}`}
                  onClick={() => onRemove(r)} aria-label={fill(copy.owner.removeLabel, { text: relText(r) })}
                >
                  <Trash2 className="size-4" aria-hidden="true" />{copy.owner.remove}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Sheet>
  );
}
