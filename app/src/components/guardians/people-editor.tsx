"use client";
/** Edits a short list of people (a trusted person's backups or watchers): name + wallet per row, with suggestions. */
import { useId, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "@/components/ui/icons";
import { Button, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { checkPeople, type Person } from "./derive";
import type { Seat } from "@/lib/guardians/types";
import type { Base58 } from "@/lib/types";
import { NamesNotice } from "@/components/continuity/names-notice";

export function PeopleEditor({
  kind, seat, owner, holders, initial, suggestions, busy, onSave, onCancel, note,
}: {
  /** What saving also does, when it does more than change the list. */
  note?: string;
  kind: "backups" | "monitors";
  seat: Seat;
  owner: Base58;
  holders: readonly (Base58 | null)[];
  initial: Person[];
  suggestions: Person[];
  busy: boolean;
  onSave: (list: Person[]) => void;
  onCancel: () => void;
}) {
  const { common, guardians: c } = useCopy();
  const id = useId();
  const [rows, setRows] = useState<Person[]>(initial.length ? initial : [{ name: "", wallet: "" }]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = kind === "backups" ? c.seat.backupN : c.seat.monitorN;
  const max = 2;
  const used = new Set(rows.map((r) => r.wallet));
  const picks = suggestions.filter((p) => !used.has(p.wallet) && p.wallet !== seat.holder).slice(0, 6);

  const set = (i: number, patch: Partial<Person>) => { setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x))); setError(null); };
  const pick = (p: Person) => {
    setError(null);
    setRows((r) => {
      const empty = r.findIndex((x) => !x.name.trim() && !x.wallet.trim());
      if (empty >= 0) return r.map((x, n) => (n === empty ? p : x));
      return r.length < max ? [...r, p] : r;
    });
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const list = rows.filter((r) => r.name.trim() || r.wallet.trim()).map((r) => ({ name: r.name.trim(), wallet: r.wallet.trim() }));
    const problem = checkPeople(list, { kind, seat, owner, holders });
    if (problem) { setError(fmt(c.peopleErrors[problem.error], { row: problem.row + 1 })); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    onSave(list);
  };

  return (
    <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface-2/50 p-3">
      <NamesNotice />
      {note && <Notice tone="warn"><p>{note}</p></Notice>}
      {rows.map((r, i) => (
        <fieldset key={i} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
          <legend className="px-1 text-small font-semibold">{fmt(label, { n: i + 1 })}</legend>
          <Field label={c.name} htmlFor={`${id}-name-${i}`}>
            <input id={`${id}-name-${i}`} value={r.name} maxLength={64} onChange={(e) => set(i, { name: e.target.value })} className={inputClass} autoComplete="off" />
          </Field>
          <Field label={c.wallet} htmlFor={`${id}-wallet-${i}`} hint={i === 0 ? c.walletHint : undefined}>
            <input id={`${id}-wallet-${i}`} value={r.wallet} onChange={(e) => set(i, { wallet: e.target.value })} className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} />
          </Field>
          <Button variant="ghost" small className="self-start" onClick={() => setRows((x) => x.filter((_, n) => n !== i))}>
            <Trash2 className="size-4" aria-hidden="true" />{fmt(c.remove, { name: r.name.trim() || fmt(label, { n: i + 1 }) })}
          </Button>
        </fieldset>
      ))}
      {rows.length < max && (
        <Button variant="secondary" small className="self-start" onClick={() => setRows((x) => [...x, { name: "", wallet: "" }])}>
          <Plus className="size-4" aria-hidden="true" />{kind === "backups" ? c.seat.addBackup : c.seat.addMonitor}
        </Button>
      )}
      {picks.length > 0 && rows.length <= max && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-ink-2">{c.suggestions}</span>
          {picks.map((p) => (
            <button key={p.wallet} type="button" onClick={() => pick(p)} className="min-h-11 rounded-full border border-line-strong bg-surface px-3.5 text-small font-medium hover:bg-surface-2">{p.name}</button>
          ))}
        </div>
      )}
      <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
      {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onCancel}>{c.cancel}</Button>
        <Button type="submit" className="flex-1" loading={busy}>{c.save}</Button>
      </div>
    </form>
  );
}
