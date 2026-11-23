import "server-only";
/**
 * ElevenLabs stock voices (premade, available to every ElevenLabs account) for when there is no cloned voice:
 *  - the parent's stand-in, which reads the parent's own words when no voice was cloned (the demo, and any estate
 *    whose owner has not recorded yet). The app labels it "an ElevenLabs stock voice", never the parent's voice;
 *  - Heirloom's voice for the disclosure line, so a child hears that it is Heirloom speaking, not the parent.
 * The browser's own speech voice is never used (decision 18 Nov 2026: ElevenLabs voices only).
 * Override with ELEVENLABS_STANDIN_VOICE_ID / ELEVENLABS_HEIRLOOM_VOICE_ID.
 */
import type { LegacyBook } from "../schema";

const STOCK = {
  he: "JBFqnCBsd6RMkjVDRZzb", // "George": warm, mature, storyteller
  she: "XrExE9yKIg1WjnnlVkGX", // "Matilda": warm, friendly
  heirloom: "EXAVITQu4vr4xnSDxMaL", // "Sarah": calm, clear
} as const;

export const standinVoice = (pronoun: LegacyBook["pronoun"]): string =>
  process.env.ELEVENLABS_STANDIN_VOICE_ID || (pronoun === "she" ? STOCK.she : STOCK.he);

export const heirloomVoice = (): string => process.env.ELEVENLABS_HEIRLOOM_VOICE_ID || STOCK.heirloom;
