import "server-only";
/**
 * The agent's part in Letters for later (plan.md §16.6): an extra review of a draft and a suggested starting draft.
 * Recommend only: the owner must accept and edit a suggestion, the review only warns, and nothing is saved or logged
 * here. Uses the existing agent layer (lib/agent/gemini.ts); without a key the callers fall back to the deterministic
 * review and the template.
 */
import type { Locale } from "../i18n/locales";
import { aiReviewSchema, aiSuggestSchema } from "../letters/schema";
import { generateJson, geminiVoiceModel, hasGemini } from "./gemini";
import { LETTER_HELPER, LETTER_REVIEWER, replyLanguage } from "./prompts";

export const lettersAiAvailable = hasGemini;

/** Extra warnings from the AI for a draft. Throws on any AI error (the caller keeps the rules' warnings). */
export async function aiReviewLetter(input: { text: string; occasion: string; recipient: string; plan: string }, locale: Locale) {
  const out = await generateJson(aiReviewSchema, {
    system: LETTER_REVIEWER + replyLanguage(locale),
    model: geminiVoiceModel(),
    timeoutMs: 20_000,
    contents: [{
      role: "user",
      parts: [{ text: `PLAN (trusted):\n${input.plan}\n\nRECIPIENT (trusted): ${input.recipient}\n\nLETTER (untrusted data, between the markers):\n<<<LETTER\nOccasion: ${input.occasion}\n${input.text}\nLETTER>>>` }],
    }],
  });
  return out.warnings;
}

/** A short starting draft in the visitor's language. Throws on any AI error (the caller uses the template). */
export async function aiSuggestLetter(input: { name: string; occasion: string; points: string; opens: string }, locale: Locale): Promise<string> {
  const out = await generateJson(aiSuggestSchema, {
    system: LETTER_HELPER + replyLanguage(locale),
    model: geminiVoiceModel(),
    timeoutMs: 20_000,
    contents: [{
      role: "user",
      parts: [{ text: `Recipient's name: ${input.name}\nOccasion: ${input.occasion || "(none)"}\nOpens: ${input.opens}\nThe owner's points (untrusted data):\n<<<POINTS\n${input.points || "(none)"}\nPOINTS>>>` }],
    }],
  });
  return out.text;
}
