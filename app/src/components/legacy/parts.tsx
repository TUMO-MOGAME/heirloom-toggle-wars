"use client";
import clsx from "clsx";
import { HeartHandshake, Pause, Phone, Play, ShieldCheck } from "@/components/ui/icons";
import type { LegacySafetyCopy } from "@/content/legacy";
import { fmt } from "@/components/shell/copy";
import { VOICE_LANGUAGES, languagesFor, type VoiceLanguage } from "@/lib/voice/languages";
import { useVoiceLanguage } from "@/lib/voice/languages-client";

/**
 * Persistent "AI voice" label (rule 3). Always visible while the legacy voice is on screen.
 * With no cloned voice (a stock stand-in reads the words) only the stand-in statement shows: saying "AI voice,
 * created with consent" next to it would contradict it.
 */
export function DisclosureLabel({ text, simulated, simulatedText, className }: { text: string; simulated: boolean; simulatedText: string; className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-2", className)}>
      <span className={clsx("inline-flex min-h-7 items-center gap-1.5 rounded-full border border-ink bg-surface px-3 text-small font-semibold text-ink", simulated && "border-dashed")}>
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />{simulated ? simulatedText : text}
      </span>
    </div>
  );
}

/** Help lines a child can open from their legacy page at any time. Always Heirloom's words, never the parent's. */
export function SafetyCard({ copy, called, adults }: { copy: LegacySafetyCopy; called: string; adults: string }) {
  return (
    <section aria-labelledby="legacy-safety" className="rounded-lg border-2 border-ink bg-surface p-4">
      <h2 id="legacy-safety" className="flex items-center gap-2 text-h3"><HeartHandshake className="size-5 shrink-0" aria-hidden="true" />{copy.title}</h2>
      <p className="mt-1 text-small text-ink-2">{fmt(copy.intro, { called })}</p>
      <p className="mt-2">{copy.body}</p>
      <ul className="mt-3 grid gap-2">
        {copy.lines.map((l) => (
          <li key={l.tel}>
            <a href={`tel:${l.tel}`} className="flex min-h-12 items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 hover:bg-surface-2">
              <Phone className="size-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{l.name}</span>
                <span className="block text-small text-ink-2">{l.note}</span>
              </span>
              <span className="font-mono font-semibold tabular-nums">{l.number}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-small">{fmt(copy.adult, { adults })}</p>
      <p className="mt-1 text-small text-ink-2">{copy.website}</p>
    </section>
  );
}

export function PlayButton({ playing, onPlay, onStop, label, stopLabel, disabled, small }: { playing: boolean; onPlay: () => void; onStop: () => void; label: string; stopLabel: string; disabled?: boolean; small?: boolean }) {
  return (
    <button
      type="button" disabled={disabled} onClick={playing ? onStop : onPlay} aria-pressed={playing}
      className={clsx("inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full font-semibold transition-colors disabled:opacity-50", small ? "px-3.5 text-small" : "px-5", playing ? "border-2 border-ink bg-surface text-ink" : "bg-ink text-bg hover:bg-ink-hover")}
    >
      {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
      {playing ? stopLabel : label}
    </button>
  );
}

/** Small live microphone level bar. */
export function LevelMeter({ level, label }: { level: number; label: string }) {
  const bars = 12;
  const lit = Math.round(Math.min(1, level) * bars);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="flex h-6 items-end gap-0.5">
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className={clsx("w-1.5 rounded-sm transition-[height,background-color] duration-75", i < lit ? "bg-ink" : "bg-line")} style={{ height: `${30 + (i / bars) * 70}%` }} />
      ))}
    </div>
  );
}

/**
 * The spoken-language choice for Legacy Voice (the shared one from lib/voice/languages-client.ts, so the call,
 * receipts and messages follow one picker). Only languages the voice can speak are offered.
 */
export function SpeechLanguagePicker({ id, label, hint, className }: { id: string; label: string; hint?: string; className?: string }) {
  const { lang, set } = useVoiceLanguage("speech");
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-small font-semibold text-ink">{label}</label>
      <select id={id} value={lang} onChange={(e) => set(e.target.value as VoiceLanguage)} aria-describedby={hint ? `${id}-hint` : undefined}
        className="block min-h-12 w-full max-w-xs rounded-md border border-line-strong bg-surface px-3.5 text-body text-ink hover:border-ink focus:border-ink">
        {languagesFor("speech").map((l) => <option key={l} value={l} lang={VOICE_LANGUAGES[l].tag}>{VOICE_LANGUAGES[l].name}</option>)}
      </select>
      {hint && <p id={`${id}-hint`} className="text-small text-ink-2">{hint}</p>}
    </div>
  );
}

/** `lang` and `dir` for text in a voice language (Arabic reads right to left). */
export const langProps = (l: VoiceLanguage) => ({ lang: VOICE_LANGUAGES[l].tag, dir: VOICE_LANGUAGES[l].rtl ? "rtl" as const : "ltr" as const });
