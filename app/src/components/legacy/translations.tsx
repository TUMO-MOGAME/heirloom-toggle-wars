"use client";
/**
 * "A parent's message in the child's language" (plan §20.1 item 4). The living owner adds their own version of a
 * message in another spoken language: typed, or a machine suggestion they must read, correct and approve. Nothing is
 * stored until they approve it (a wallet-signed write the server accepts only from the on-chain owner while the estate
 * is Active), and the voice only ever reads approved words.
 */
import { useId, useState } from "react";
import { Languages, Pencil, Plus, Sparkles, Trash2 } from "@/components/ui/icons";
import type { LegacyCopy } from "@/content/legacy";
import { useEstate } from "@/lib/hooks/estate";
import type { LegacyBook, LegacyTranslation, Milestone } from "@/lib/legacy/schema";
import { MAX_TRANSLATION_CHARS } from "@/lib/legacy/rules";
import { VOICE_LANGUAGES, languagesFor, type VoiceLanguage } from "@/lib/voice/languages";
import { Button, Card, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt } from "@/components/shell/copy";
import { PlayButton, langProps } from "./parts";
import { useLegacyPlayer } from "./use-player";
import { legacyError } from "./use-legacy";

type Copy = LegacyCopy;
interface Draft { milestoneId: string; lang: VoiceLanguage; text: string; suggested: boolean; confirmed: boolean }

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });
const nameOf = (l: VoiceLanguage) => VOICE_LANGUAGES[l].name;

export function TranslationStudio({ copy, book, versions, active, reload }: { copy: Copy; book: LegacyBook; versions: readonly LegacyTranslation[]; active: boolean; reload: () => Promise<void> }) {
  const t = copy.owner.translations;
  const [draft, setDraft] = useState<Draft | null>(null);
  const { play, stop, playing } = useLegacyPlayer();

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-h3"><Languages className="size-5 shrink-0" aria-hidden="true" />{t.title}</h2>
      <p className="mt-1 text-ink-2">{t.body}</p>
      <Notice tone="neutral" className="mt-3"><p>{t.rule}</p></Notice>
      {!active && <p className="mt-3 text-small text-ink-2">{t.sealed}</p>}
      {book.milestones.length === 0 ? <p className="mt-3 text-ink-2">{t.needSaved}</p> : (
        <ul className="mt-4 grid gap-3">
          {book.milestones.map((m) => (
            <MessageVersions key={m.id} copy={copy} m={m} versions={versions.filter((v) => v.milestoneId === m.id)} active={active}
              draft={draft?.milestoneId === m.id ? draft : null} setDraft={setDraft} reload={reload} player={{ play, stop, playing }} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MessageVersions({ copy, m, versions, active, draft, setDraft, reload, player }: {
  copy: Copy; m: Milestone; versions: LegacyTranslation[]; active: boolean; draft: Draft | null;
  setDraft: (d: Draft | null) => void; reload: () => Promise<void>; player: ReturnType<typeof useLegacyPlayer>;
}) {
  const t = copy.owner.translations;
  const { service, snap, notify } = useEstate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const free = languagesFor("speech").filter((l) => !versions.some((v) => v.lang === l));

  const hear = async (v: LegacyTranslation) => {
    if (!service || !snap) return;
    setError(null);
    try { await player.play(`${m.id}@${v.lang}`, await service.legacySpeak(snap.estate.address, { milestoneId: m.id, lang: v.lang })); }
    catch (e) { setError(legacyError(e, copy.child.error)); }
  };
  const remove = async (v: LegacyTranslation) => {
    if (!service || !snap) return;
    setBusy(`rm-${v.lang}`); setError(null);
    try { await service.deleteLegacyTranslation(snap.estate.address, { milestoneId: m.id, lang: v.lang }); notify("ok", t.removed); await reload(); }
    catch (e) { setError(legacyError(e, copy.child.error)); }
    finally { setBusy(null); }
  };

  return (
    <li className="rounded-md border border-line p-3.5">
      <p className="font-semibold">{m.title}</p>
      <p className="text-small text-ink-2">{copy.owner.book.kinds[m.kind]}</p>
      <figure className="mt-2">
        <figcaption className="text-small font-semibold text-ink-2">{t.original}</figcaption>
        <blockquote className="mt-0.5 text-small" dir="auto">{m.text}</blockquote>
      </figure>

      {versions.length === 0 ? <p className="mt-2 text-small text-ink-2">{t.none}</p> : (
        <ul className="mt-3 grid gap-2">
          {versions.map((v) => (
            <li key={v.lang} className={v.stale ? "rounded-md border border-dashed border-line-strong p-3" : "rounded-md border border-ink p-3"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold" lang={VOICE_LANGUAGES[v.lang].tag}>{nameOf(v.lang)}</span>
                <span className="text-small text-ink-2">{fmt(t.approvedOn, { date: fmtDate(v.approvedAt) })}</span>
              </div>
              <p className="mt-1 text-small" {...langProps(v.lang)}>{v.text}</p>
              {v.stale && <p className="mt-2 text-small font-semibold">{t.stale}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {!v.stale && (
                  <PlayButton small playing={player.playing === `${m.id}@${v.lang}`} onPlay={() => void hear(v)} onStop={player.stop}
                    label={fmt(t.play, { language: nameOf(v.lang) })} stopLabel={t.stop} />
                )}
                {active && (
                  <>
                    <Button variant="secondary" small onClick={() => setDraft({ milestoneId: m.id, lang: v.lang, text: v.text, suggested: false, confirmed: false })}>
                      <Pencil className="size-4" aria-hidden="true" />{t.edit}
                    </Button>
                    <Button variant="ghost" small loading={busy === `rm-${v.lang}`} onClick={() => void remove(v)}>
                      <Trash2 className="size-4" aria-hidden="true" />{t.remove}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="mt-2 text-small font-medium text-danger">{error}</p>}
      {active && (draft ? (
        <Editor copy={copy} m={m} draft={draft} setDraft={setDraft} taken={versions.map((v) => v.lang)} reload={reload} />
      ) : free.length > 0 ? (
        <Button variant="secondary" small className="mt-3" onClick={() => setDraft({ milestoneId: m.id, lang: free[0], text: "", suggested: false, confirmed: false })}>
          <Plus className="size-4" aria-hidden="true" />{t.add}
        </Button>
      ) : <p className="mt-3 text-small text-ink-2">{t.allAdded}</p>)}
    </li>
  );
}

function Editor({ copy, m, draft, setDraft, taken, reload }: { copy: Copy; m: Milestone; draft: Draft; setDraft: (d: Draft | null) => void; taken: VoiceLanguage[]; reload: () => Promise<void> }) {
  const t = copy.owner.translations;
  const { service, snap, notify } = useEstate();
  const id = useId();
  const [busy, setBusy] = useState<"suggest" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const language = nameOf(draft.lang);
  // Editing keeps its own language; a new version offers the languages not yet added.
  const options = languagesFor("speech").filter((l) => l === draft.lang || !taken.includes(l));
  const editing = taken.includes(draft.lang);

  const suggest = async () => {
    if (!service || !snap) return;
    setBusy("suggest"); setError(null);
    try {
      const s = await service.suggestLegacyTranslation(snap.estate.address, { milestoneId: m.id, lang: draft.lang });
      // A suggestion is only a draft: the owner must read and confirm it again.
      setDraft({ ...draft, text: s.text, suggested: true, confirmed: false });
    } catch (e) { setError(legacyError(e, copy.child.error)); }
    finally { setBusy(null); }
  };
  const approve = async () => {
    if (!service || !snap) return;
    if (!draft.text.trim()) return setError(fmt(t.needText, { language }));
    if (!draft.confirmed) return setError(t.needConfirm);
    setBusy("save"); setError(null);
    try {
      await service.saveLegacyTranslation(snap.estate.address, { milestoneId: m.id, lang: draft.lang, text: draft.text.trim() });
      notify("ok", fmt(t.saved, { language }));
      setDraft(null);
      await reload();
    } catch (e) { setError(legacyError(e, copy.child.error)); }
    finally { setBusy(null); }
  };

  return (
    <div className="mt-3 grid gap-3 rounded-md border-2 border-ink p-3.5">
      <Field label={t.language} htmlFor={`${id}-lang`} className="max-w-xs">
        <select id={`${id}-lang`} className={inputClass} value={draft.lang} disabled={editing || busy !== null}
          onChange={(e) => setDraft({ ...draft, lang: e.target.value as VoiceLanguage, text: "", suggested: false, confirmed: false })}>
          {options.map((l) => <option key={l} value={l} lang={VOICE_LANGUAGES[l].tag}>{nameOf(l)}</option>)}
        </select>
      </Field>
      <Field label={fmt(t.text, { language })} htmlFor={`${id}-text`} hint={t.textHint}>
        <textarea id={`${id}-text`} rows={5} maxLength={MAX_TRANSLATION_CHARS} value={draft.text} {...langProps(draft.lang)}
          aria-describedby={`${id}-text-hint`}
          onChange={(e) => setDraft({ ...draft, text: e.target.value, confirmed: false })} className={`${inputClass} min-h-28 py-2.5`} />
      </Field>
      {draft.suggested && <Notice tone="warn"><p>{t.suggested}</p></Notice>}
      <div>
        <Button variant="secondary" small loading={busy === "suggest"} disabled={busy === "save"} onClick={() => void suggest()}>
          <Sparkles className="size-4" aria-hidden="true" />{busy === "suggest" ? t.suggesting : t.suggest}
        </Button>
      </div>
      <label htmlFor={`${id}-ok`} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-line-strong bg-surface p-3 text-small text-ink">
        <input id={`${id}-ok`} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-ink" checked={draft.confirmed}
          onChange={(e) => { setDraft({ ...draft, confirmed: e.target.checked }); setError(null); }} />
        <span>{t.confirm}</span>
      </label>
      {error && <p role="alert" className="text-small font-medium text-danger">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" loading={busy === "save"} disabled={busy === "suggest"} onClick={() => void approve()}>{t.approve}</Button>
        <Button variant="ghost" disabled={busy !== null} onClick={() => setDraft(null)}>{t.cancel}</Button>
      </div>
    </div>
  );
}
