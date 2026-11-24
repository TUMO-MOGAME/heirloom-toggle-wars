"use client";
/**
 * The spoken-language choice (plan §20.1), reusable by every voice feature: pass the capability it is for, and only
 * languages ElevenLabs can do that for are listed (lib/voice/languages.ts). "Same as the app" (null) follows the UI
 * language, or English when the UI language can't be spoken; a line says so. One choice is shared by all pickers.
 */
import { Field, inputClass } from "@/components/ui/primitives";
import { fmt } from "@/components/shell/copy";
import { voice as voiceEnglish } from "@/content/voice";
import { LOCALE_NAMES } from "@/lib/i18n/locales";
import { useLocale, useLocalized } from "@/lib/i18n/client";
import { isVoiceLanguage, languagesFor, resolveVoiceLanguage, VOICE_LANGUAGES, type VoiceCapability, type VoiceLanguage } from "@/lib/voice/languages";
import { useVoiceLanguage } from "@/lib/voice/languages-client";

/** The picker's languages for `capability`, in order: never one ElevenLabs can't do it in. */
export function voicePickerOptions(capability: VoiceCapability): { value: VoiceLanguage; name: string; tag: string; rtl: boolean }[] {
  return languagesFor(capability).map((value) => ({ value, name: VOICE_LANGUAGES[value].name, tag: VOICE_LANGUAGES[value].tag, rtl: !!VOICE_LANGUAGES[value].rtl }));
}

export function VoiceLanguagePicker({ capability = "agent", id = "voice-language", disabled, className }: {
  capability?: VoiceCapability; id?: string; disabled?: boolean; className?: string;
}) {
  const copy = useLocalized(voiceEnglish, (t) => t.voice).picker;
  const ui = useLocale();
  const { chosen, set } = useVoiceLanguage(capability);
  const same = resolveVoiceLanguage(capability, null, ui);
  const value = chosen && VOICE_LANGUAGES[chosen].support[capability] ? chosen : "";
  const fallback = value === "" && same !== ui ? fmt(copy.fallback, { ui: LOCALE_NAMES[ui], lang: VOICE_LANGUAGES[same].name }) : null;

  return (
    <Field label={copy.label} htmlFor={id} className={className} hint={<>{copy.hint}{fallback && <><br />{fallback}</>}</>}>
      <select
        id={id} value={value} disabled={disabled} aria-describedby={`${id}-hint`}
        lang={value ? VOICE_LANGUAGES[value].tag : undefined} dir={value && VOICE_LANGUAGES[value].rtl ? "rtl" : undefined}
        onChange={(e) => set(isVoiceLanguage(e.target.value) ? e.target.value : null)}
        className={inputClass}
      >
        <option value="">{fmt(copy.same, { name: VOICE_LANGUAGES[same].name })}</option>
        {voicePickerOptions(capability).map((o) => (
          <option key={o.value} value={o.value} lang={o.tag} dir={o.rtl ? "rtl" : undefined}>{o.name}</option>
        ))}
      </select>
    </Field>
  );
}
