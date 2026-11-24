import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { dailyCap, handler, HttpError, isChainMode, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { chatMessageSchema } from "@/lib/agent/schemas";
import { orchestrate, ROUTABLE } from "@/lib/agent/orchestrator";
import { toEstateFacts, type EstateFacts } from "@/lib/agent/facts";
import { estateFactsSchema } from "@/lib/agent/facts-schema";
import { loadPublicSnapshot, loadSnapshot } from "@/lib/server/estate";
import { memberReader } from "@/lib/access/server";
import { saveTranscript } from "@/lib/db";
import { isVoiceLanguage, type VoiceLanguage } from "@/lib/voice/languages";

export const maxDuration = 60;

/** A spoken language (lib/voice/languages.ts, a superset of the UI locales); anything else (e.g. "none") is ignored. */
const language = z.preprocess((v) => (isVoiceLanguage(v) ? v : undefined), z.custom<VoiceLanguage>().optional());

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const body = z.object({
  // Browser shape
  text: z.string().min(1).max(4000).optional(),
  history: z.array(chatMessageSchema).max(30).optional(),
  context: z.object({ persona: z.string().max(80).optional(), role: z.string().max(20).optional(), estate: addr.optional(), page: z.string().max(120).optional() }).optional(),
  // Object from the browser chat; JSON string (or "none") from the ElevenLabs webhook's {{facts}} dynamic variable.
  facts: z.preprocess((v) => {
    if (typeof v !== "string") return v;
    if (v === "none" || v === "") return undefined;
    try { return JSON.parse(v); } catch { return undefined; }
  }, estateFactsSchema.optional()),
  specialist: z.enum(ROUTABLE).optional(),
  sessionId: z.string().max(80).optional(),
  // ElevenLabs webhook shape (see scripts/elevenlabs-agent.md)
  message: z.string().min(1).max(4000).optional(),
  persona: z.string().max(80).optional(),
  estate: z.string().max(64).optional(),
  page: z.string().max(120).optional(),
  conversation_id: z.string().max(80).optional(),
  // The visitor's language (both shapes); the agent replies in it. `lang` is the call's spoken language
  // ({{lang}} from the voice session, plan §20) and wins over `locale`, the app's language.
  locale: language,
  lang: language,
}).refine((b) => b.text || b.message || b.history?.length, "text, message or history is required");

function secretOk(given: string): boolean {
  const want = process.env.ELEVENLABS_TOOL_SECRET ?? "";
  if (!want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/agent/orchestrate → { specialist, reply, actions[], draft?, needsHuman?, routedBy }.
 * Callers: the in-app text chat (rate-limited per IP) and the ElevenLabs agent's server tool
 * (must send header `x-heirloom-tool-secret: $ELEVENLABS_TOOL_SECRET`).
 */
export const POST = handler(async (req) => {
  const secret = req.headers.get("x-heirloom-tool-secret");
  const channel = secret !== null ? "voice" : "text";
  if (secret !== null && !secretOk(secret)) throw new HttpError(401, "Bad tool secret", "unauthorized");
  await rateLimitShared(req, `orchestrate-${channel}`, channel === "voice" ? 120 : 20);

  const b = await parseJson(req, body);
  await dailyCap(req, channel === "voice" ? "model-voice" : "model");
  const userText = b.text ?? b.message;
  const history = [...(b.history ?? []), ...(userText ? [{ role: "user" as const, text: userText }] : [])].slice(-20);
  const persona = b.context?.persona ?? b.persona;
  const estateAddr = b.context?.estate ?? (b.estate && addr.safeParse(b.estate).success ? b.estate : undefined);
  const role = b.context?.role ?? persona?.split(":")[0];

  // Text chat: use the facts the screen sent. Voice: in chain mode read the chain first (the caller's {{facts}} were
  // captured when the call started); otherwise, and in mock mode, the facts from the call's dynamic variable.
  let facts: EstateFacts | null = channel === "text" ? b.facts ?? null : null;
  if (!facts && estateAddr && isChainMode()) {
    // Names and reports only for a member with a read pass; anyone else hears what the chain already shows.
    const member = await memberReader(req, estateAddr).catch(() => null);
    facts = await (member ? loadSnapshot(estateAddr) : loadPublicSnapshot(estateAddr)).then(toEstateFacts).catch(() => null);
  }
  facts ??= b.facts ?? null;

  const result = await orchestrate({ history, facts, context: { persona, role, page: b.context?.page ?? b.page, channel, locale: b.lang ?? b.locale } }, b.specialist);

  const sessionId = b.sessionId ?? b.conversation_id;
  if (sessionId && userText) {
    void saveTranscript([
      { sessionId, channel, persona: persona ?? null, estate: estateAddr ?? null, role: "user", specialist: null, text: userText },
      { sessionId, channel, persona: persona ?? null, estate: estateAddr ?? null, role: "agent", specialist: result.specialist, text: result.reply },
    ]);
  }
  return json(result);
});
