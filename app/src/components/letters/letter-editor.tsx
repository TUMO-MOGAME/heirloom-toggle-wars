"use client";
/**
 * Write or edit a letter (loaded only when the owner opens it). Who it is for, when it opens (at unlock, on a date, or
 * with a payment under one of that person's rules), what it is about, the occasion and the words. "Help me write it"
 * offers a starting draft the owner must accept and change; "Check my letter" warns about secrets and about anything
 * that disagrees with the plan. Warnings never block saving, but saving with warnings needs "I have read the
 * warnings". Nothing is saved until the owner signs.
 */
import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, Info, ShieldAlert, Sparkles, TriangleAlert } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/client";
import { Button, Field, Notice, inputClass } from "@/components/ui/primitives";
import { useCopy } from "@/components/shell/copy";
import { useEstate } from "@/lib/hooks/estate";
import type { EstateSnapshot } from "@/lib/service";
import type { Locale } from "@/lib/i18n/locales";
import { fromBase } from "@/lib/format";
import { newLetterId } from "@/lib/letters/canonical";
import { letterErrorKey } from "@/lib/letters/errors";
import { sastDay } from "@/lib/letters/rules";
import { fillTemplate } from "@/lib/letters/template";
import { LETTER_MAX_CHARS, OCCASION_MAX, type LetterInput, type LetterOpens, type LetterReview, type LetterView } from "@/lib/letters/types";
import { dateText, fill, letterWords, nameOf, usdt, type Copy } from "./words";

type When = "unlock" | "date" | "payment";
const radioRow = "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-line-strong bg-surface p-3";

export function LetterEditor({ copy, snap, locale, letter, onClose, onSaved }: {
  copy: Copy; snap: EstateSnapshot; locale: Locale; letter: LetterView | null; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const id = useId();
  const { common } = useCopy();
  const { service, notify } = useEstate();
  const estate = snap.estate.address;
  const people = snap.beneficiaries.filter((b) => b.active);
  const start = letter ? letterWords(letter, copy) : { occasion: "", text: "" };

  const [toKind, setToKind] = useState<"family" | "person">(letter?.to.kind ?? "person");
  const [person, setPerson] = useState(letter?.to.kind === "person" ? letter.to.wallet : people[0]?.wallet ?? "");
  const [when, setWhen] = useState<When>(letter && letter.opens.kind !== "send" ? letter.opens.kind : "unlock");
  const [date, setDate] = useState(letter?.opens.kind === "date" ? letter.opens.on : "");
  const [rule, setRule] = useState(letter?.opens.kind === "payment" ? letter.opens.rule : "");
  const [about, setAbout] = useState(letter?.about?.asset ?? "");
  const [occasion, setOccasion] = useState(start.occasion);
  const [text, setText] = useState(start.text);
  const [points, setPoints] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [review, setReview] = useState<LetterReview | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<"save" | "check" | "help" | null>(null);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);

  const [tomorrow] = useState(() => sastDay(Date.now() + 86_400_000));
  const rulesFor = snap.rules.filter((r) => toKind === "person" && r.beneficiary === person);
  const chars = [...text.trim()].length;
  const whenNow: When = toKind === "family" && when === "payment" ? "unlock" : when;
  const warnings = review?.warnings ?? [];
  const recipientName = toKind === "family" ? copy.list.family : nameOf(snap, person);

  const input = (): LetterInput | null => {
    let opens: LetterOpens = { kind: "unlock" };
    if (whenNow === "date") {
      if (!date || date < tomorrow) { setError({ field: "date", message: copy.editor.dateNeeded }); return null; }
      opens = { kind: "date", on: date };
    }
    if (whenNow === "payment") {
      if (!rule || !rulesFor.some((r) => r.address === rule)) { setError({ field: "rule", message: copy.editor.ruleNeeded }); return null; }
      opens = { kind: "payment", rule };
    }
    if (!text.trim()) { setError({ field: "text", message: copy.editor.empty }); return null; }
    if (chars > LETTER_MAX_CHARS) { setError({ field: "text", message: fill(copy.editor.tooLong, { max: LETTER_MAX_CHARS.toLocaleString("en-ZA") }) }); return null; }
    return {
      id: letter?.id ?? newLetterId(), to: toKind === "family" ? { kind: "family" } : { kind: "person", wallet: person }, opens, occasion, text,
      ...(about ? { about: { asset: about } } : {}),
      ...(letter?.transcribed ? { transcribed: letter.transcribed } : {}),
    };
  };

  const explainError = (e: unknown) => copy.errors[(letterErrorKey(e) ?? "network") as keyof Copy["errors"]];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const draft = input();
    if (!draft || !service) return;
    setBusy("save");
    try {
      await service.saveLetter(estate, draft, (letter?.version ?? 0) + 1);
      notify("ok", copy.editor.saved);
      await onSaved();
    } catch (err) {
      setError({ field: (err as { field?: string }).field ?? "form", message: explainError(err) });
    } finally { setBusy(null); }
  };

  const check = async () => {
    setError(null);
    const draft = input();
    if (!draft || !service) return;
    setBusy("check");
    try { setReview(await service.reviewLetter(estate, draft, locale)); setAck(false); } catch (err) { setError({ field: "form", message: explainError(err) }); } finally { setBusy(null); }
  };

  const help = async () => {
    if (!service) return;
    setBusy("help");
    try {
      const s = await service.suggestLetter(estate, { to: toKind === "family" ? { kind: "family" } : { kind: "person", wallet: person }, occasion, points }, locale);
      // Without the AI the suggestion is a template, written in the visitor's language here.
      setSuggestion(s.source === "template" ? fillTemplate(copy.help.templates, whenNow, recipientName, occasion) : s.text);
    } catch (err) { setError({ field: "form", message: explainError(err) }); } finally { setBusy(null); }
  };

  const warningText = (w: LetterReview["warnings"][number]) => {
    const vars = { ...w.vars, ...(w.vars?.name === "family" ? { name: copy.review.familyName } : {}) };
    return fill(copy.review.codes[w.code], vars);
  };
  const ruleLabel = (r: EstateSnapshot["rules"][number]) => {
    const category = common.status.category[r.category];
    return r.recurringAmount > BigInt(0) && r.nextDue
      ? fill(copy.editor.ruleOption, { category, amount: usdt(fromBase(r.recurringAmount)), date: dateText(r.nextDue, locale) })
      : fill(copy.editor.ruleOptionNoDate, { category, amount: usdt(fromBase(r.recurringAmount > BigInt(0) ? r.recurringAmount : r.maxPerClaim)) });
  };
  const err = (f: string) => (error?.field === f ? error.message : null);
  const mustAck = warnings.length > 0 && !ack;

  return (
    <Sheet
      open onClose={onClose} tall title={letter ? copy.editor.titleEdit : copy.editor.titleNew} closeLabel={copy.editor.cancel}
      footer={(
        <div className="grid gap-2">
          {error?.field === "form" && <p role="alert" className="flex items-start gap-1.5 text-small font-semibold"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{error.message}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{copy.editor.cancel}</Button>
            <Button type="submit" form={`${id}-form`} loading={busy === "save"} disabled={mustAck || busy !== null}>{copy.editor.save}</Button>
          </div>
        </div>
      )}
    >
      <form id={`${id}-form`} onSubmit={(e) => void save(e)} className="grid gap-5" noValidate>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-small font-semibold">{copy.editor.to}</legend>
          <label className={radioRow}>
            <input type="radio" name={`${id}-to`} checked={toKind === "person"} onChange={() => setToKind("person")} className="mt-1 size-5 accent-[var(--accent)]" />
            <span><span className="font-medium">{copy.editor.person}</span><span className="block text-small text-ink-2">{copy.editor.personHint}</span></span>
          </label>
          {toKind === "person" && (
            <select aria-label={copy.editor.person} value={person} onChange={(e) => { setPerson(e.target.value); setRule(""); }} className={inputClass}>
              {people.map((b) => <option key={b.wallet} value={b.wallet}>{nameOf(snap, b.wallet)}</option>)}
            </select>
          )}
          <label className={radioRow}>
            <input type="radio" name={`${id}-to`} checked={toKind === "family"} onChange={() => setToKind("family")} className="mt-1 size-5 accent-[var(--accent)]" />
            <span><span className="font-medium">{copy.editor.family}</span><span className="block text-small text-ink-2">{copy.editor.familyHint}</span></span>
          </label>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-small font-semibold">{copy.editor.when}</legend>
          <label className={radioRow}>
            <input type="radio" name={`${id}-when`} checked={whenNow === "unlock"} onChange={() => setWhen("unlock")} className="mt-1 size-5 accent-[var(--accent)]" />
            <span className="font-medium">{copy.editor.whenUnlock}</span>
          </label>
          <label className={radioRow}>
            <input type="radio" name={`${id}-when`} checked={whenNow === "date"} onChange={() => setWhen("date")} className="mt-1 size-5 accent-[var(--accent)]" />
            <span><span className="font-medium">{copy.editor.whenDate}</span><span className="block text-small text-ink-2">{copy.editor.whenDateHint}</span></span>
          </label>
          {whenNow === "date" && (
            <Field label={copy.editor.whenDate} htmlFor={`${id}-date`} error={err("date")}>
              <input id={`${id}-date`} type="date" min={tomorrow} max="2126-12-31" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} aria-invalid={!!err("date") || undefined} />
            </Field>
          )}
          {toKind === "person" ? (
            <label className={radioRow}>
              <input type="radio" name={`${id}-when`} checked={whenNow === "payment"} onChange={() => setWhen("payment")} className="mt-1 size-5 accent-[var(--accent)]" />
              <span><span className="font-medium">{copy.editor.whenPayment}</span><span className="block text-small text-ink-2">{copy.editor.whenPaymentHint}</span></span>
            </label>
          ) : <p className="text-small text-ink-2">{copy.editor.familyNoPayment}</p>}
          {whenNow === "payment" && (rulesFor.length ? (
            <Field label={copy.editor.whenPayment} htmlFor={`${id}-rule`} error={err("rule") ?? err("opens")}>
              <select id={`${id}-rule`} value={rule} onChange={(e) => setRule(e.target.value)} className={inputClass}>
                <option value="">{copy.editor.ruleNeeded}</option>
                {rulesFor.map((r) => <option key={r.address} value={r.address}>{ruleLabel(r)}</option>)}
              </select>
            </Field>
          ) : <p className="text-small text-ink-2">{fill(copy.editor.noRules, { name: recipientName })}</p>)}
        </fieldset>

        {snap.assets.length > 0 && (
          <Field label={copy.editor.about} htmlFor={`${id}-about`}>
            <select id={`${id}-about`} value={about} onChange={(e) => setAbout(e.target.value)} className={inputClass}>
              <option value="">{copy.editor.aboutNone}</option>
              {snap.assets.map((a) => <option key={a.address} value={a.address}>{a.title}</option>)}
            </select>
          </Field>
        )}

        <Field label={copy.editor.occasion} htmlFor={`${id}-occasion`} hint={copy.editor.occasionHint}>
          <input id={`${id}-occasion`} value={occasion} maxLength={OCCASION_MAX} onChange={(e) => setOccasion(e.target.value)} className={inputClass} autoComplete="off" />
        </Field>

        <section aria-labelledby={`${id}-help`} className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <h3 id={`${id}-help`} className="flex items-center gap-2 text-small font-semibold"><Sparkles className="size-4 text-amber" aria-hidden="true" />{copy.editor.help}</h3>
          <Field label={copy.help.points} htmlFor={`${id}-points`} hint={copy.help.pointsHint}>
            <input id={`${id}-points`} value={points} maxLength={300} onChange={(e) => setPoints(e.target.value)} className={inputClass} autoComplete="off" />
          </Field>
          <div><Button variant="secondary" small loading={busy === "help"} disabled={busy !== null} onClick={() => void help()}>{busy === "help" ? copy.help.asking : copy.help.ask}</Button></div>
          {suggestion !== null && (
            <div className="grid gap-2 rounded-md border border-line-strong bg-surface p-3" aria-live="polite">
              <p className="text-small font-semibold">{copy.help.label}</p>
              <p className="whitespace-pre-wrap text-small">{suggestion}</p>
              <div className="flex flex-wrap gap-2">
                <Button small onClick={() => { setText(suggestion); setSuggestion(null); setReview(null); }}><Check className="size-4" aria-hidden="true" />{copy.help.use}</Button>
                <Button variant="ghost" small onClick={() => setSuggestion(null)}>{copy.help.dismiss}</Button>
              </div>
            </div>
          )}
        </section>

        <Field label={copy.editor.text} htmlFor={`${id}-text`} error={err("text")} hint={<span className="tabular-nums" aria-live="polite">{fill(copy.editor.counter, { count: chars.toLocaleString("en-ZA"), max: LETTER_MAX_CHARS.toLocaleString("en-ZA") })}</span>}>
          <textarea
            id={`${id}-text`} value={text} rows={10} onChange={(e) => { setText(e.target.value); setAck(false); }}
            className={`${inputClass} min-h-56 py-3 leading-relaxed`} aria-invalid={!!err("text") || chars > LETTER_MAX_CHARS || undefined}
          />
        </Field>

        <div className="grid gap-3">
          <div><Button variant="secondary" loading={busy === "check"} disabled={busy !== null} onClick={() => void check()}><ShieldAlert className="size-5" aria-hidden="true" />{busy === "check" ? copy.editor.checking : copy.editor.check}</Button></div>
          {review && (
            <section aria-labelledby={`${id}-review`} aria-live="polite" className="grid gap-2">
              <h3 id={`${id}-review`} className="font-semibold">{copy.review.title}</h3>
              {warnings.length === 0 ? <Notice tone="ok" icon={<Check className="size-5" aria-hidden="true" />}>{copy.review.none}</Notice> : (
                <>
                  <p className="text-small text-ink-2">{copy.review.intro}</p>
                  <ul className="grid gap-2" data-warnings>
                    {warnings.map((w) => (
                      <li key={w.code} data-code={w.code} className="rounded-md border border-line-strong bg-surface p-3">
                        <p className="flex items-start gap-2 font-medium"><TriangleAlert className="mt-1 size-4 shrink-0 text-amber" aria-hidden="true" />{warningText(w)}</p>
                        {w.quote && <p className="mt-1 border-l-2 border-line-strong pl-2 text-small italic text-ink-2">“{w.quote}”</p>}
                        {w.note && <p className="mt-1 text-small text-ink-2">{w.note}</p>}
                      </li>
                    ))}
                  </ul>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-line-strong bg-surface p-3 text-small">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]" />
                    <span className="font-semibold">{copy.editor.ackWarnings}</span>
                  </label>
                </>
              )}
              <p className="text-[0.75rem] text-ink-2">{review.source === "rules" ? copy.review.source.rules : copy.review.source.ai}</p>
            </section>
          )}
        </div>

        <Notice icon={<Info className="size-5" aria-hidden="true" />}>
          {copy.notWill}{" "}
          <Link href="/privacy#letters" target="_blank" className="font-semibold text-ink underline underline-offset-4">{copy.privacy}</Link>
        </Notice>
      </form>
    </Sheet>
  );
}
