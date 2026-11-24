/**
 * The demo story's speakable lines (mock mode): the demo Legacy Book's milestone messages, the fixed sample line and
 * Heirloom's disclosure, and the owner's approved versions in other languages ("<milestone id>@<lang>").
 * /api/legacy/demo-voice renders exactly these with ElevenLabs and nothing else. The mock
 * service only points at a line while the owner's text still matches it, so an edited message is never voiced
 * with the old words.
 */
import { legacyVoiceSample } from "@/content/legacy";
import { DEMO_TRANSLATIONS, demoLegacyBook } from "./demo-book";
import { disclosureLine } from "./rules";

/** `lang`: the language of an approved version (picks the text-to-speech model); absent for the original words. */
export type DemoVoiceLine = { text: string; voice: "parent" | "heirloom"; lang?: string };

/** Bump when a demo line's words change, so browsers and the CDN fetch the new audio (2: no more "phone your gogo"). */
export const DEMO_VOICE_VERSION = 2;

export function demoVoiceText(line: string): DemoVoiceLine | null {
  const book = demoLegacyBook();
  if (line === "sample") return { text: legacyVoiceSample, voice: "parent" };
  // The demo has no cloned voice: a stock voice stands in, and the disclosure says so.
  if (line === "disclosure") return { text: disclosureLine(book, true), voice: "heirloom" };
  const at = line.indexOf("@");
  if (at > 0) {
    const t = DEMO_TRANSLATIONS.find((x) => `${x.milestoneId}@${x.lang}` === line);
    return t ? { text: t.text, voice: "parent", lang: t.lang } : null;
  }
  const m = book.milestones.find((x) => x.id === line);
  return m ? { text: m.text, voice: "parent" } : null;
}

export const demoVoiceUrl = (line: string) => `/api/legacy/demo-voice?line=${encodeURIComponent(line)}&v=${DEMO_VOICE_VERSION}`;

/** The demo line for an approved version of a message in another language. */
export const demoVersionLine = (milestoneId: string, lang: string) => `${milestoneId}@${lang}`;
