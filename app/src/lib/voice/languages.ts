/**
 * The languages Heirloom can SPEAK and HEAR (plan §20), separate from the four UI languages in lib/i18n/locales.ts.
 * A family in Lagos, Luanda or Paris can call the agent, dictate a plan and hear receipts in their own language while
 * the screens stay in English (or one of the UI languages). Shared by browser and server: no React, no browser APIs.
 *
 * `support` says which ElevenLabs product can handle the language:
 *  - agent: the voice call (Agents Platform)        - speech: text to speech (receipts, Legacy Voice)
 *  - listen: speech to text (Scribe)
 * Never offer a capability for a language whose flag is false.
 *
 * Checked by el/agent on 24 Nov 2026 against ElevenLabs' docs and SDK:
 *  - agent: the Agents Platform's conversation language list, as the API spec ships it in @elevenlabs/types 0.29.0
 *    (`ConversationConfigOverrideAgentLanguage`: has en fr pt es ar hi zh af sw, NOT zu or st; the Agents Platform
 *    language page returned 403 to us, so the API's own enum decides: zu stays false although eleven_v4_turbo can
 *    say it, because the API would reject `language: "zu"`. Re-check when the SDK adds it), with agent TTS
 *    `eleven_v4_turbo` (the default for new agents; https://elevenlabs.io/docs/models recommends it for agents).
 *    af and sw need eleven_v4_turbo: Flash v2.5 / Multilingual v2 do not speak them. scripts/elevenlabs-agent.ts sets it.
 *  - speech: https://elevenlabs.io/docs/models language lists. Multilingual v2 (29) and Flash/Turbo v2.5 (32) have
 *    en fr pt es ar hi zh. eleven_v3 (70+) adds af and sw, not zu. eleven_v4 / eleven_v4_turbo (90+) add af, sw AND zu.
 *    No model lists Sesotho (Southern Sotho). Use `speechModelFor()` to pick a model that can say the language.
 *  - listen: Scribe (scribe_v3 current; tiers from the v2 table) at https://elevenlabs.io/docs/capabilities/speech-to-text: en fr pt es (excellent, <=5% WER),
 *    hi sw zh (high, 5-10%), af ar (good, 10-20%), zu (moderate, 25-50% WER: show the words for editing). Sesotho is not
 *    listed; only Northern Sotho (nso) is, a different language, so st stays false.
 */
import type { Locale } from "../i18n/locales";

export type VoiceLanguage =
  | "en" | "zu" | "st" | "af"            // the UI languages
  | "fr" | "pt" | "es" | "ar" | "sw" | "hi" | "zh"; // widely spoken, for growth beyond South Africa

export interface VoiceLanguageInfo {
  /** Named in itself, for the picker. */
  name: string;
  /** English name, for prompts and logs. */
  english: string;
  /** BCP 47 tag for `lang` attributes. */
  tag: string;
  /** ISO 639-1 code ElevenLabs expects. */
  elevenlabs: string;
  /** Right-to-left script. */
  rtl?: boolean;
  support: { agent: boolean; speech: boolean; listen: boolean };
}

export const VOICE_LANGUAGES: Record<VoiceLanguage, VoiceLanguageInfo> = {
  en: { name: "English", english: "English", tag: "en-ZA", elevenlabs: "en", support: { agent: true, speech: true, listen: true } },
  zu: { name: "isiZulu", english: "isiZulu", tag: "zu-ZA", elevenlabs: "zu", support: { agent: false, speech: true, listen: true } },
  st: { name: "Sesotho", english: "Sesotho", tag: "st-ZA", elevenlabs: "st", support: { agent: false, speech: false, listen: false } },
  af: { name: "Afrikaans", english: "Afrikaans", tag: "af-ZA", elevenlabs: "af", support: { agent: true, speech: true, listen: true } },
  fr: { name: "Français", english: "French", tag: "fr", elevenlabs: "fr", support: { agent: true, speech: true, listen: true } },
  pt: { name: "Português", english: "Portuguese", tag: "pt", elevenlabs: "pt", support: { agent: true, speech: true, listen: true } },
  es: { name: "Español", english: "Spanish", tag: "es", elevenlabs: "es", support: { agent: true, speech: true, listen: true } },
  ar: { name: "العربية", english: "Arabic", tag: "ar", elevenlabs: "ar", rtl: true, support: { agent: true, speech: true, listen: true } },
  sw: { name: "Kiswahili", english: "Swahili", tag: "sw", elevenlabs: "sw", support: { agent: true, speech: true, listen: true } },
  hi: { name: "हिन्दी", english: "Hindi", tag: "hi", elevenlabs: "hi", support: { agent: true, speech: true, listen: true } },
  zh: { name: "中文", english: "Mandarin Chinese", tag: "zh", elevenlabs: "zh", support: { agent: true, speech: true, listen: true } },
};

/** Text-to-speech models with a short language list; any language outside it needs the v4 family (90+). */
const MULTILINGUAL_V2: readonly VoiceLanguage[] = ["en", "fr", "pt", "es", "ar", "hi", "zh"];

/**
 * The text-to-speech model to use for `lang` (docs checked 24 Nov 2026). speech=true for af, sw and zu REQUIRES
 * eleven_v4, so receipts and Legacy Voice must call this rather than hard-code eleven_multilingual_v2. Returns
 * Multilingual v2 where it can (the model the app already uses), else Eleven v4 (af, sw, zu). Only meaningful when
 * `support.speech` is true.
 */
export function speechModelFor(lang: VoiceLanguage): "eleven_multilingual_v2" | "eleven_v4" {
  return MULTILINGUAL_V2.includes(lang) ? "eleven_multilingual_v2" : "eleven_v4";
}

export const VOICE_LANGUAGE_CODES = Object.keys(VOICE_LANGUAGES) as VoiceLanguage[];

/** Where the browser remembers the spoken language (no cookie). Unset = follow the UI language. */
export const VOICE_LANGUAGE_STORAGE_KEY = "heirloom.voiceLang";

export function isVoiceLanguage(v: unknown): v is VoiceLanguage {
  return typeof v === "string" && v in VOICE_LANGUAGES;
}

export type VoiceCapability = keyof VoiceLanguageInfo["support"];

/** Languages that can do `capability`, in picker order. */
export function languagesFor(capability: VoiceCapability): VoiceLanguage[] {
  return VOICE_LANGUAGE_CODES.filter((l) => VOICE_LANGUAGES[l].support[capability]);
}

/**
 * The language to use for `capability`: the chosen spoken language if it can, else the UI language if it can,
 * else English. Never returns a language that can't do it.
 */
export function resolveVoiceLanguage(capability: VoiceCapability, chosen: VoiceLanguage | null, ui: Locale): VoiceLanguage {
  if (chosen && VOICE_LANGUAGES[chosen].support[capability]) return chosen;
  if (VOICE_LANGUAGES[ui].support[capability]) return ui;
  return "en";
}
