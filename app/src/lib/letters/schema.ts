/**
 * Zod shapes for the letters API (plan.md §16.7). Loaded only by the server routes and the letter editor, never on a
 * first paint. Lengths are checked again after cleaning by lib/letters/rules.ts checkLetter (a clear 413 / 422).
 */
import { z } from "zod";
import { LETTER_ID } from "./types";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const personId = z.string().regex(/^(local:[a-z0-9-]{1,40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);

export const letterToSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("family") }),
  z.object({ kind: z.literal("person"), wallet: addr }),
]);
export const letterOpensSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unlock") }),
  z.object({ kind: z.literal("date"), on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ kind: z.literal("payment"), rule: addr }),
  z.object({ kind: z.literal("send"), signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,90}$/) }),
]);
/** Text and occasion are capped generously here; the exact limits apply after cleaning (checkLetter). */
export const letterInputSchema = z.object({
  id: z.string().regex(LETTER_ID),
  to: letterToSchema,
  opens: letterOpensSchema,
  occasion: z.string().max(400),
  text: z.string().max(12_000),
  about: z.object({ asset: addr }).optional(),
  transcribed: z.object({ person: personId, year: z.number().int() }).optional(),
});

const common = {
  estate: addr, wallet: addr, ts: z.number().int().positive(), sig: z.string().regex(/^[0-9a-f]{128}$/),
};
export const lettersBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...common }),
  z.object({ action: z.literal("write"), ...common, letter: letterInputSchema, version: z.number().int().min(1).max(1_000_000) }),
  z.object({ action: z.literal("delete"), ...common, id: z.string().regex(LETTER_ID), version: z.number().int().min(1).max(1_000_000) }),
]);
export type LettersBody = z.infer<typeof lettersBodySchema>;

const locale = z.enum(["en", "af", "st", "zu"]);
export const suggestInputSchema = z.object({ to: letterToSchema, occasion: z.string().max(120), points: z.string().max(300) });
export const reviewBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), ...common, draft: letterInputSchema, locale }),
  z.object({ action: z.literal("suggest"), ...common, input: suggestInputSchema, locale }),
]);
export type ReviewBody = z.infer<typeof reviewBodySchema>;

/** What the AI reviewer may answer (plan.md §16.6): at most 6 warnings. */
export const aiReviewSchema = z.object({
  warnings: z.array(z.object({
    code: z.enum(["secret.password", "secret.pin", "secret.seed", "secret.card", "secret.account", "secret.idNumber", "will.asset", "will.amount", "will.other"]),
    quote: z.string().max(120).optional(),
    note: z.string().max(200).optional(),
  })).max(6),
});
export const aiSuggestSchema = z.object({ text: z.string().min(1).max(1200) });
