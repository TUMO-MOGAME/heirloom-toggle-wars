/**
 * Legacy Voice: the parent's Legacy Book and the consent record for their cloned voice.
 * Client-safe (no server imports): used by the routes, the mock service and the UI editor.
 *
 * Safeguards encoded here (see README "Legacy Voice"):
 *  - consent is given by the living owner only, as a recorded line + an unticked box (validateVoiceInput)
 *  - the voice only speaks the owner's own milestone messages; it never writes new words (plan §16.17)
 *  - voice_id never appears in any type the browser receives (LegacyVoiceInfo has no id)
 */
import { z } from "zod";
import { MAX_TRANSLATION_CHARS, MILESTONE_KINDS } from "./rules";
import { VOICE_LANGUAGES, VOICE_LANGUAGE_CODES, type VoiceLanguage } from "../voice/languages";

// The zod-free part (types the browser shares, consent rules, helpers) lives in ./rules, so the demo and the
// screens can use it without loading zod. Re-exported here, so server code keeps one import.
export * from "./rules";


const line = (max: number) => z.string().trim().max(max);
const text = (max: number) => z.string().trim().max(max).default("");

export const guidanceSchema = z.object({
  study: text(800),
  money: text(800),
  faith: text(800),
  family: text(800),
  other: text(800),
});
export type Guidance = z.infer<typeof guidanceSchema>;

export const legacyChildSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: line(40).min(1),
  /** Wallet of the beneficiary, when known, so the server can match the signed-in child. */
  wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,48}$/).optional(),
  guidance: guidanceSchema,
  note: text(800),
});
export type LegacyChild = z.infer<typeof legacyChildSchema>;

export const milestoneSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** A child id from children[], or "all". */
  childId: z.string().regex(/^[a-z0-9-]{1,32}$/),
  kind: z.enum(MILESTONE_KINDS),
  title: line(80).min(1),
  text: line(1200).min(1),
});
export type Milestone = z.infer<typeof milestoneSchema>;

export const legacyBookSchema = z.object({
  version: z.literal(1).default(1),
  ownerName: line(80).min(1),
  /** What the children call them: "Dad", "Mama", "Papa", "Tata"… */
  calledBy: line(20).min(1).default("Dad"),
  pronoun: z.enum(["he", "she", "they"]).default("he"),
  values: z.array(line(300).min(1)).max(12).default([]),
  lessons: z.array(line(400).min(1)).max(12).default([]),
  phrases: z.array(line(200).min(1)).max(12).default([]),
  guidance: guidanceSchema,
  children: z.array(legacyChildSchema).max(8).default([]),
  milestones: z.array(milestoneSchema).max(40).default([]),
}).superRefine((b, ctx) => {
  const kids = new Set(b.children.map((c) => c.id));
  if (kids.size !== b.children.length) ctx.addIssue({ code: "custom", path: ["children"], message: "Child ids must be unique" });
  const ms = new Set<string>();
  b.milestones.forEach((m, i) => {
    if (ms.has(m.id)) ctx.addIssue({ code: "custom", path: ["milestones", i, "id"], message: "Milestone ids must be unique" });
    ms.add(m.id);
    if (m.childId !== "all" && !kids.has(m.childId)) ctx.addIssue({ code: "custom", path: ["milestones", i, "childId"], message: "Unknown child" });
  });
});
export type LegacyBook = z.infer<typeof legacyBookSchema>;


/* ---------- the owner's approved versions in other languages ---------- */

export const milestoneIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** A language the voice can speak (ElevenLabs text to speech); anything else is refused. */
export const speechLanguageSchema = z.enum(VOICE_LANGUAGE_CODES as [VoiceLanguage, ...VoiceLanguage[]])
  .refine((l) => VOICE_LANGUAGES[l].support.speech, "The voice can't speak that language.");

/** Which version: a message and a language. Strict: nothing else rides along. */
export const translationKeySchema = z.object({ milestoneId: milestoneIdSchema, lang: speechLanguageSchema }).strict();
export type TranslationKey = z.infer<typeof translationKeySchema>;

/** The owner approves these exact words for this message in this language. */
export const translationInputSchema = translationKeySchema.extend({ text: line(MAX_TRANSLATION_CHARS).min(1) }).strict();
export type TranslationInput = z.infer<typeof translationInputSchema>;
