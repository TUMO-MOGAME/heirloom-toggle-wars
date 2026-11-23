"use client";
/**
 * The owner, while alive, puts someone new in a trusted place (owner_replace_seat), or fills an empty one. Says what
 * the contract does to the place: the old holder loses the seat at once, backups and monitors stay (minus the new
 * person), a reported passing is cancelled, and the holder count goes up by one.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, Consent, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import type { Seat } from "@/lib/guardians/types";
import type { Base58 } from "@/lib/types";
import { NamesNotice } from "@/components/continuity/names-notice";
import { afterReplacement, checkReplacement, shortName, type Person, type ReplaceError } from "./derive";

export function ReplaceSeatForm({
  seat, owner, agent, cancelsPassing, holders, suggestions, busy, onSubmit, onCancel, openObjection = false, otherSeats = [],
}: {
  agent: Base58;
  /** A death claim is open: replacing someone is proof of life, so it is cancelled (R2). */
  cancelsPassing: boolean;
  /** An Open objection to this place's succession: the contract leaves it in place, and until it is voted on it blocks the next succession here. */
  openObjection?: boolean;
  /** The other places: if the new person is a backup there, the contract leaves them on that list. */
  otherSeats?: readonly Seat[];
  seat: Seat;
  owner: Base58;
  holders: readonly (Base58 | null)[];
  suggestions: Person[];
  busy: boolean;
  onSubmit: (person: Person) => void;
  onCancel: () => void;
}) {
  const { common, guardians: g } = useCopy();
  const c = g.replace;
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const walletRef = useRef<HTMLInputElement>(null);
  const [person, setPerson] = useState<Person>({ name: "", wallet: "" });
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<ReplaceError | null>(null);
  const [consentError, setConsentError] = useState(false);

  // Move focus into the form when it opens, so keyboard and screen-reader users land on its title.
  useEffect(() => { headingRef.current?.focus(); }, []);

  const vacant = seat.vacant || !seat.holder;
  const holderName = shortName(seat.holderName);
  const after = afterReplacement(seat, person.wallet);
  const picks = suggestions.filter((p) => p.wallet !== owner && !holders.includes(p.wallet)).slice(0, 6);
  const otherBackupOf = otherSeats.find((o) => o.backups.some((b) => b.wallet === person.wallet.trim()));
  const list = (people: Person[]) => people.map((p) => p.name).join(", ");

  const update = (patch: Partial<Person>) => { setPerson((p) => ({ ...p, ...patch })); setError(null); };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const clean = { name: person.name.trim(), wallet: person.wallet.trim() };
    const problem = checkReplacement(clean, { owner, holders, agent });
    if (problem) {
      setError(problem);
      (problem === "name" ? nameRef : walletRef).current?.focus();
      return;
    }
    if (!consent) { setConsentError(true); return; }
    onSubmit(clean);
  };

  const nameError = error === "name" ? c.errors.name : null;
  const walletError = error && error !== "name" ? c.errors[error] : null;

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface-2/50 p-3">
      <h4 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="font-sans text-body font-semibold tracking-normal">
        {vacant ? c.fillTitle : fmt(c.title, { name: seat.holderName })}
      </h4>
      <p className="text-small text-ink-2">{vacant ? c.fillBody : fmt(c.body, { name: holderName })}</p>

      <NamesNotice />
      <Field label={c.newName} htmlFor={`${id}-name`} error={nameError}>
        <input
          id={`${id}-name`} ref={nameRef} value={person.name} maxLength={64} autoComplete="off" className={inputClass}
          onChange={(e) => update({ name: e.target.value })}
          aria-invalid={!!nameError || undefined} aria-describedby={nameError ? `${id}-name-error` : undefined}
        />
      </Field>
      <Field label={c.newWallet} htmlFor={`${id}-wallet`} hint={g.walletHint} error={walletError}>
        <input
          id={`${id}-wallet`} ref={walletRef} value={person.wallet} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`}
          onChange={(e) => update({ wallet: e.target.value })}
          aria-invalid={!!walletError || undefined} aria-describedby={walletError ? `${id}-wallet-error` : `${id}-wallet-hint`}
        />
      </Field>
      {picks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-small text-ink-2">{g.suggestions}</span>
          {picks.map((p) => (
            <button
              key={p.wallet} type="button" onClick={() => update({ name: p.name, wallet: p.wallet })} aria-pressed={person.wallet.trim() === p.wallet}
              className="min-h-11 rounded-full border border-line-strong bg-surface px-3.5 text-small font-medium hover:bg-surface-2 aria-pressed:border-ink aria-pressed:bg-surface-2"
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      <Notice tone="accent" title={c.effectsTitle}>
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
          {cancelsPassing && <li className="font-semibold">{g.rules.here.warning}</li>}
          {!vacant && <li>{fmt(c.effectHolder, { name: holderName })}</li>}
          {seat.succession && !vacant && <li>{fmt(c.effectSuccession, { name: holderName })}</li>}
          <li>{after.backups.length ? fmt(c.effectBackups, { list: list(after.backups) }) : c.effectNoBackups}</li>
          <li>{after.monitors.length ? fmt(c.effectMonitors, { list: list(after.monitors) }) : c.effectNoMonitors}</li>
          {after.removed && <li>{fmt(c.effectRemoved, { name: person.name.trim() || person.wallet.trim() })}</li>}
          <li>{fmt(c.effectHistory, { n: seat.generation + 2 })}</li>
          {openObjection && !vacant && <li>{c.warnObjection}</li>}
          {otherBackupOf && <li>{fmt(c.warnOtherBackup, { name: person.name.trim() || person.wallet.trim(), holder: shortName(otherBackupOf.holderName) })}</li>}
        </ul>
      </Notice>

      <Consent id={`${id}-consent`} checked={consent} onChange={(v) => { setConsent(v); setConsentError(false); }} copy={common.consent} />
      {consentError && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{common.consentRequired}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={onCancel}>{g.cancel}</Button>
        <Button type="submit" className="flex-1" loading={busy}>{vacant ? c.fillSubmit : fmt(c.submit, { name: holderName })}</Button>
      </div>
    </form>
  );
}
