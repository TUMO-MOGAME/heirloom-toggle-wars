import { z } from "zod";
import { handler, json, rateLimitShared } from "@/lib/api/http";
import { speak } from "@/lib/legacy/server/service";
import { authJson } from "@/lib/legacy/server/http";

export const maxDuration = 30;

// Strict: a body that carries any text of its own is refused (400), so no client can choose the words.
const body = z.union([
  z.object({ milestoneId: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
  z.object({ sample: z.literal(true) }).strict(),
  z.object({ disclosure: z.literal(true) }).strict(),
]);

/**
 * POST /api/legacy/speak { milestoneId } | { sample: true } | { disclosure: true } → audio/mpeg from ElevenLabs: the
 * parent's cloned voice, or a labelled ElevenLabs stock voice when none was cloned; the disclosure in Heirloom's voice.
 * JSON { simulated: true, text } only when ElevenLabs is not configured (the app then shows the words, no browser voice).
 * The voice only says words its owner wrote or approved while alive: a milestone message from the Legacy Book,
 * or, for the owner while the estate is active, one fixed sample line. Never free text.
 * Rate limits: 20/min per IP, 200/day per estate.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "legacy-speak", 20);
  const { body: b, viewer } = await authJson(req, "speak", body);
  const out = await speak(viewer, b);
  if (!out.audio) return json({ simulated: true, text: out.text });
  return new Response(out.audio as BodyInit, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-legacy-voice": out.voice } });
});
