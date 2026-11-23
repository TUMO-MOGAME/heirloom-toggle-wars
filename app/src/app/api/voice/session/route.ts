import { dailyCap, handler, HttpError, json, rateLimitShared } from "@/lib/api/http";
import { gone } from "@/lib/legacy/server/gone";

/**
 * GET /api/voice/session → { signedUrl } for @elevenlabs/client (WebSocket). Uses ELEVENLABS_API_KEY and
 * ELEVENLABS_AGENT_ID server-side only (ElevenLabs GET /v1/convai/conversation/get-signed-url, header xi-api-key).
 * 503 { code: "unavailable" } when voice is not configured, so the UI falls back to text chat.
 */
export const GET = handler(async (req) => {
  await rateLimitShared(req, "voice-session", 10);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) throw new HttpError(503, "Voice is not configured.", "unavailable");
  await dailyCap(req, "voice");
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(url, { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!res.ok) throw new HttpError(502, `Voice service error (${res.status}).`, "upstream");
  const data = (await res.json()) as { signed_url?: string };
  if (!data.signed_url) throw new HttpError(502, "Voice service returned no session.", "upstream");
  return json({ signedUrl: data.signed_url });
});

/**
 * POST /api/voice/session { mode: "legacy" } was a live call in the parent's cloned voice. Removed on 18 Nov 2026
 * (plan §16.17): the voice only ever says words its owner wrote or approved while alive. 410 Gone.
 */
export const POST = gone;
