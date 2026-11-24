/**
 * Voice typing limits and language mapping (plan §20.1 item 2), shared by the browser hook (useDictation.ts) and the
 * route (/api/voice/transcribe). No React, no browser or server APIs.
 */
import { VOICE_LANGUAGES, VOICE_LANGUAGE_CODES, isVoiceLanguage, type VoiceLanguage } from "./languages";

/** A clip stops by itself after this long. */
export const DICTATION_MAX_SECS = 60;
/** The browser records at this rate, so a minute is about 250 KB; the route refuses anything above MAX_BYTES. */
export const DICTATION_BITRATE = 32_000;
export const DICTATION_MAX_BYTES = 2_000_000;
/** What MediaRecorder makes in current browsers (Chrome/Edge/Firefox: WebM or Ogg Opus; Safari: MP4/AAC), plus WAV. */
export const DICTATION_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/wave"] as const;

/** The MIME type without parameters ("audio/webm;codecs=opus" → "audio/webm"), lower case. */
export const baseType = (t: string) => t.split(";")[0].trim().toLowerCase();
export const isDictationType = (t: string) => (DICTATION_TYPES as readonly string[]).includes(baseType(t));
/** A file name extension for an accepted type ("audio/x-wav" → "wav"). */
export const extensionFor = (t: string) => { const sub = baseType(t).split("/")[1] ?? ""; return /wav/.test(sub) ? "wav" : sub; };

/** ISO 639-3 codes Scribe may answer with, for the languages Heirloom lists. */
const ISO3: Record<string, VoiceLanguage> = {
  eng: "en", zul: "zu", sot: "st", afr: "af", fra: "fr", fre: "fr", por: "pt", spa: "es", ara: "ar", swa: "sw", swh: "sw", hin: "hi", zho: "zh", cmn: "zh", chi: "zh",
};

/** The VoiceLanguage for a code Scribe returns (ISO 639-1 or 639-3), or null for any other language. */
export function fromScribeCode(code: unknown): VoiceLanguage | null {
  if (typeof code !== "string") return null;
  const c = code.trim().toLowerCase();
  const two = VOICE_LANGUAGE_CODES.find((l) => VOICE_LANGUAGES[l].elevenlabs === c);
  return two ?? ISO3[c] ?? null;
}

/**
 * The language to ask Scribe for: a listen-capable VoiceLanguage, or null to let Scribe detect it (no code given, or a
 * language Scribe can't hear well). Throws for anything that is not a VoiceLanguage at all.
 */
export function listenLanguage(code: string | null | undefined): VoiceLanguage | null {
  if (code === null || code === undefined || code === "") return null;
  if (!isVoiceLanguage(code)) throw new RangeError("Unknown language");
  return VOICE_LANGUAGES[code].support.listen ? code : null;
}
