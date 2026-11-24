/**
 * Legacy Voice rules shared by the browser and the server without zod: the kinds, the public types, the consent
 * line and the voice-recording checks, and small book helpers. The zod schemas (and the book's types inferred from
 * them) are in ./schema, which re-exports all of this.
 *
 * The rule (18 Nov 2026, plan §16.17): the voice only ever says words its owner wrote or approved while alive.
 * It plays the owner's messages for moments; it never answers questions, takes calls or writes new words.
 */
import type { Guidance, LegacyBook, LegacyChild, Milestone } from "./schema";
import { VOICE_LANGUAGES, isVoiceLanguage, type VoiceLanguage } from "../voice/languages";
import { sha256Hex } from "../agent/hash";

export const MILESTONE_KINDS = ["firstFees", "graduation", "firstJob", "birthday", "hardDay", "other"] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];
export const GUIDANCE_TOPICS = ["study", "money", "faith", "family", "other"] as const satisfies readonly (keyof Guidance)[];

/** Public info about the voice. Deliberately has NO voice id: that stays on the server. */
export interface LegacyVoiceInfo {
  ownerName: string;
  /** Epoch ms when the owner recorded consent. */
  consentedAt: number;
  samples: number;
  /** True when no cloned voice exists: a labelled ElevenLabs stock voice reads the words (never the browser's voice). */
  simulated: boolean;
  /** ElevenLabs may ask the account holder to verify a new voice before it can be used. */
  needsVerification?: boolean;
}

export interface LegacyStatus {
  voice: LegacyVoiceInfo | null;
  book: LegacyBook | null;
  /** For a child: whether they switched the legacy voice on. Owner: always true. */
  optedIn: boolean;
  /** Who is asking, as the server/mock resolved it. */
  viewer: "owner" | "child" | "other";
  /** The child entry in the book that matches the viewer, if any. */
  childId: string | null;
  /** Children hear the messages only after the estate unlocks. */
  unlocked: boolean;
  /**
   * The owner's approved versions of their messages in other spoken languages (plan §20.1 item 4). The owner sees
   * all of them, stale ones flagged; a child sees only current ones, and only when the book is open to them.
   */
  translations?: LegacyTranslation[];
}

export interface LegacySpeech {
  text: string;
  /** Object URL of rendered audio (ElevenLabs). Null when there is no audio: the UI shows the words instead. */
  audioUrl: string | null;
  simulated: boolean;
  /** "heirloom" = the default assistant voice (the disclosure), never the parent's. */
  voice: "parent" | "heirloom";
}

/* ---------- the owner's own words in other languages ---------- */

/**
 * One message in another spoken language, approved by the living owner (signed by their wallet while the estate was
 * Active). The voice reads it in that language; it is still the owner's own words, because the owner read, edited
 * and approved every word. A machine suggestion is never stored or played until the owner approves it.
 */
export interface LegacyTranslation {
  milestoneId: string;
  lang: VoiceLanguage;
  /** The approved words, exactly as the owner approved them. */
  text: string;
  /** SHA-256 of `text`. */
  sha256: string;
  /** SHA-256 of the original message when the owner approved this. */
  sourceSha256: string;
  /** Epoch ms of the approval. */
  approvedAt: number;
  /** The original message changed after approval: never played until the owner approves it again. */
  stale?: boolean;
}

export const MAX_TRANSLATION_CHARS = 2000;

/** Languages a message can be read in: those ElevenLabs text to speech can speak (lib/voice/languages.ts). */
export function isSpeechLanguage(l: unknown): l is VoiceLanguage {
  return isVoiceLanguage(l) && VOICE_LANGUAGES[l].support.speech;
}

/** The current (not stale) approved version of a message in `lang`, if there is one. */
export function approvedVersion(list: readonly LegacyTranslation[] | undefined, milestoneId: string, lang: VoiceLanguage | null | undefined): LegacyTranslation | null {
  if (!lang || !list) return null;
  return list.find((t) => t.milestoneId === milestoneId && t.lang === lang && !t.stale) ?? null;
}

/**
 * Lays the stored versions over the book as it is now: versions of deleted messages are dropped, and a version whose
 * original changed after approval is marked stale (it never plays until the owner approves it again).
 */
export async function currentVersions(book: LegacyBook, list: readonly LegacyTranslation[]): Promise<LegacyTranslation[]> {
  const shas = new Map<string, string>();
  for (const m of book.milestones) shas.set(m.id, await sha256Hex(m.text));
  return list.flatMap((t) => {
    const sha = shas.get(t.milestoneId);
    return sha ? [{ ...t, stale: sha !== t.sourceSha256 }] : [];
  });
}

/* ---------- what the voice says around the messages ---------- */

export interface Pronouns { subject: string; object: string; possessive: string }
export function pronouns(p: LegacyBook["pronoun"]): Pronouns {
  return p === "she" ? { subject: "she", object: "her", possessive: "her" }
    : p === "they" ? { subject: "they", object: "them", possessive: "their" }
      : { subject: "he", object: "him", possessive: "his" };
}

/**
 * Said in Heirloom's own voice before the first message plays (honest disclosure). With no cloned voice (`standin`)
 * an ElevenLabs stock voice reads the parent's words, so the line must not claim it is the parent's voice.
 */
export function disclosureLine(book: Pick<LegacyBook, "calledBy" | "pronoun">, standin = false): string {
  const p = pronouns(book.pronoun).possessive;
  const called = book.calledBy.toLowerCase();
  return standin
    ? `This is Heirloom. Next you will hear your ${called}'s own words, read by a stand-in voice, not ${p} own.`
    : `This is Heirloom. Next you will hear your ${called}'s own words, in ${p} voice: an AI copy made with ${p} consent.`;
}

/**
 * True when no cloned voice reads the book: there is no voice, or the voice has no recordings behind it (the demo,
 * a devnet demo stock voice) or no ElevenLabs voice. A labelled ElevenLabs stock voice then stands in.
 */
export const isStandin = (voice: LegacyVoiceInfo | null | undefined): boolean => !voice || voice.simulated;

/**
 * An empty Legacy Book for an owner who has not written one yet: one entry per family member in the plan (matched
 * by wallet), no messages. Writing the book never needs a cloned voice; the stand-in reads it until there is one.
 */
export function starterBook(ownerName: string, family: readonly { label: string; wallet?: string }[]): LegacyBook {
  const blank = { study: "", money: "", faith: "", family: "", other: "" };
  const used = new Set<string>();
  const children = family.slice(0, 8).flatMap((f) => {
    const name = f.label.replace(/\s*\(.*\)$/, "").trim();
    const first = name.split(/\s+/)[0] ?? "";
    let id = first.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 28) || "child";
    for (let n = 2; used.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
    if (!name) return [];
    used.add(id);
    return [{ id, name: name.slice(0, 40), ...(f.wallet ? { wallet: f.wallet } : {}), guidance: { ...blank }, note: "" }];
  });
  return {
    version: 1, ownerName: ownerName.trim().slice(0, 80) || "Me", calledBy: "Dad", pronoun: "he",
    values: [], lessons: [], phrases: [], guidance: { ...blank }, children, milestones: [],
  };
}

/* ---------- consent ---------- */

export const CONSENT_LINE = "I, {name}, agree that Heirloom may create a copy of my voice to read my own messages to my family after I'm gone.";
export const consentLine = (name: string) => CONSENT_LINE.replace("{name}", name.trim());

export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 8;
export const MIN_SAMPLE_BYTES = 4 * 1024;
export const MAX_SAMPLE_BYTES = 3 * 1024 * 1024;
/** Vercel functions accept ~4.5 MB per request; we stay under it. */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const AUDIO_MIME = ["audio/webm", "audio/ogg", "audio/mpeg", "audio/wav", "audio/mp4"] as const;
export type AudioMime = (typeof AUDIO_MIME)[number];

export interface VoiceInput {
  ownerName: string;
  consentAccepted: boolean;
  consentText: string;
  consentAudio: { size: number; type: string } | null;
  samples: { size: number; type: string }[];
}

/** Strips codec params: "audio/webm;codecs=opus" → "audio/webm". */
export const baseMime = (t: string) => t.split(";")[0].trim().toLowerCase();

/** Same checks on device (mock + UI) and on the server. Returns a list of problems; empty = OK. */
export function validateVoiceInput(v: VoiceInput): string[] {
  const out: string[] = [];
  if (!v.ownerName.trim()) out.push("Your name is needed for the consent line.");
  if (!v.consentAccepted) out.push("Tick the consent box to continue.");
  if (v.consentText.trim() !== consentLine(v.ownerName)) out.push("The consent line must be the exact sentence shown.");
  if (!v.consentAudio) out.push("Record yourself reading the consent line first.");
  const files = [...(v.consentAudio ? [v.consentAudio] : []), ...v.samples];
  if (v.samples.length < MIN_SAMPLES) out.push(`Record at least ${MIN_SAMPLES} short samples.`);
  if (v.samples.length > MAX_SAMPLES) out.push(`At most ${MAX_SAMPLES} samples.`);
  for (const f of files) {
    if (!(AUDIO_MIME as readonly string[]).includes(baseMime(f.type))) { out.push("Recordings must be WebM, Ogg, MP3, WAV or MP4 audio."); break; }
  }
  for (const f of files) {
    if (f.size < MIN_SAMPLE_BYTES) { out.push("One recording is too short. Speak for at least a few seconds."); break; }
    if (f.size > MAX_SAMPLE_BYTES) { out.push("One recording is too long. Keep each under a minute."); break; }
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) out.push("The recordings are too large together. Keep the total to about two minutes.");
  return out;
}

/** Magic-byte sniffing so a renamed file is rejected. */
export function sniffAudio(b: Uint8Array): AudioMime | null {
  const s = (i: number, str: string) => [...str].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (s(0, "OggS")) return "audio/ogg";
  if (s(0, "RIFF") && s(8, "WAVE")) return "audio/wav";
  if (s(4, "ftyp")) return "audio/mp4";
  if (s(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

/** Milestones that apply to one child (their own + "all"). */
export function milestonesFor(book: LegacyBook, childId: string | null): Milestone[] {
  return book.milestones.filter((m) => m.childId === "all" || m.childId === childId);
}

/** Finds the book's child entry for a wallet / display label. */
export function matchChild(book: LegacyBook, wallet: string | null | undefined, label?: string | null): LegacyChild | null {
  if (wallet) { const w = book.children.find((c) => c.wallet === wallet); if (w) return w; }
  const first = label?.split(/[ (]/)[0]?.toLowerCase();
  return first ? book.children.find((c) => c.name.split(" ")[0].toLowerCase() === first) ?? null : null;
}

/** The book's message for one moment for this child: their own first, then one for all the children. */
export function findMoment(book: LegacyBook, child: LegacyChild | null, kind: MilestoneKind): Milestone | null {
  const list = milestonesFor(book, child?.id ?? null).filter((m) => m.kind === kind);
  return list.find((m) => m.childId === child?.id) ?? list[0] ?? null;
}
