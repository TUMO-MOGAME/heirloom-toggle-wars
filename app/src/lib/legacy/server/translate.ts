import "server-only";
/**
 * "Suggest a translation" (plan §20.1 item 4): Gemini translates the owner's own message, faithfully. Nothing is
 * stored here: the suggestion goes back to the living owner, who reads, edits and approves it (a separate signed
 * write). Gemini is the operator for this one step only; the privacy policy names it.
 */
import { z } from "zod";
import { HttpError } from "@/lib/api/http";
import { AgentError, generateJson, hasGemini } from "@/lib/agent/gemini";
import type { VoiceLanguage } from "@/lib/voice/languages";
import { MAX_TRANSLATION_CHARS } from "../rules";
import { translationPrompt } from "../translate-prompt";

const reply = z.object({ translation: z.string().trim().min(1).max(MAX_TRANSLATION_CHARS) });

export async function suggestTranslation(text: string, lang: VoiceLanguage): Promise<string> {
  if (!hasGemini()) throw new HttpError(503, "Suggestions aren't available here. Type your message in that language yourself.", "unavailable");
  const p = translationPrompt(lang, text);
  try {
    const out = await generateJson(reply, { system: p.system, contents: [{ role: "user", parts: [{ text: p.user }] }], timeoutMs: 20_000, deadline: Date.now() + 25_000 });
    return out.translation;
  } catch (e) {
    console.error("[legacy] translation suggestion failed:", e instanceof Error ? e.message : e);
    throw new HttpError(e instanceof AgentError && e.code === "timeout" ? 504 : 503, "A suggestion isn't available right now. You can type the message yourself.", "unavailable");
  }
}
