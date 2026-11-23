import { dailyCap, handler, HttpError, rateLimitShared } from "@/lib/api/http";
import { demoVoiceText } from "@/lib/legacy/demo-voice";
import { hasElevenLabs, textToSpeech } from "@/lib/legacy/server/elevenlabs";
import { heirloomVoice, standinVoice } from "@/lib/legacy/server/standin";

export const maxDuration = 30;

const cache = new Map<string, Uint8Array>();

/**
 * GET /api/legacy/demo-voice?line=<milestone id | sample | disclosure> → audio/mpeg for the demo story (mock mode).
 * Only the demo Legacy Book's fixed lines can be spoken (lib/legacy/demo-voice.ts), never text from the request,
 * so this is not a free text-to-speech service. Thabo's lines use an ElevenLabs stock voice (labelled in the app);
 * the disclosure uses Heirloom's own voice. Responses are public and immutable, so the CDN serves repeats and
 * ElevenLabs is asked once per line per deployment. Rate limit: 20/min per IP.
 */
export const GET = handler(async (req) => {
  const line = new URL(req.url).searchParams.get("line") ?? "";
  const found = demoVoiceText(line);
  if (!found) throw new HttpError(404, "That line is not part of the demo.", "not_found");
  if (!hasElevenLabs()) throw new HttpError(503, "The voice is not available right now.", "unavailable");
  let audio = cache.get(line);
  if (!audio) {
    await rateLimitShared(req, "legacy-demo-voice", 20);
    await dailyCap(req, "tts");
    audio = await textToSpeech(found.voice === "heirloom" ? heirloomVoice() : standinVoice("he"), found.text).catch((e: unknown) => {
      console.error("[legacy] demo voice failed:", e instanceof Error ? e.message : e);
      throw new HttpError(503, "The voice is not available right now.", "unavailable");
    });
    cache.set(line, audio);
  }
  return new Response(audio as BodyInit, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400, s-maxage=31536000, immutable", "x-legacy-voice": found.voice },
  });
});
