import "server-only";
/**
 * ElevenLabs REST calls for Legacy Voice (xi-api-key header, server only). Endpoints (checked Nov 2026):
 *  - Instant Voice Cloning   POST   /v1/voices/add                (multipart: name, files[], remove_background_noise,
 *                                                                  description, labels) → { voice_id, requires_verification }
 *  - Delete voice            DELETE /v1/voices/{voice_id}
 *  - Text to speech          POST   /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128 { text, model_id, voice_settings }
 *  - Delete old call agent   DELETE /v1/convai/agents/{agent_id}  (voices made before 18 Nov 2026 had a private agent
 *                                                                  for live calls; live calls were removed, plan §16.17)
 */
const BASE = "https://api.elevenlabs.io";

export const hasElevenLabs = () => Boolean(process.env.ELEVENLABS_API_KEY);
const key = () => {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ElevenLabs is not configured.");
  return k;
};

export class ElevenLabsError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ElevenLabsError"; }
}

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "xi-api-key": key(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Never echo request bodies; the detail is ElevenLabs' validation message only.
    throw new ElevenLabsError(res.status, `ElevenLabs ${init.method ?? "GET"} ${path.split("?")[0].replace(/\/[A-Za-z0-9_-]{16,}/g, "/…")} failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res;
}

export async function createInstantVoice(input: { name: string; description: string; files: { bytes: Uint8Array; mime: string; name: string }[] }): Promise<{ voiceId: string; requiresVerification: boolean }> {
  const form = new FormData();
  form.set("name", input.name);
  form.set("description", input.description);
  form.set("remove_background_noise", "true");
  form.set("labels", JSON.stringify({ use: "heirloom-legacy", accent: "south african" }));
  for (const f of input.files) form.append("files", new Blob([f.bytes as BlobPart], { type: f.mime }), f.name);
  const res = await call("/v1/voices/add", { method: "POST", body: form, timeoutMs: 60_000 });
  const data = (await res.json()) as { voice_id?: string; requires_verification?: boolean };
  if (!data.voice_id) throw new ElevenLabsError(502, "ElevenLabs returned no voice.");
  return { voiceId: data.voice_id, requiresVerification: Boolean(data.requires_verification) };
}

export async function deleteElevenVoice(voiceId: string): Promise<void> {
  try { await call(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE" }); }
  catch (e) { if (!(e instanceof ElevenLabsError && e.status === 404)) throw e; }
}

/**
 * The text-to-speech model for a language (checked 24 Nov 2026, elevenlabs.io/docs/overview/models):
 * eleven_multilingual_v2 does not speak Afrikaans, Swahili or isiZulu; eleven_v4 does. Everything else stays on
 * eleven_multilingual_v2. ELEVENLABS_TTS_MODEL overrides both. `null` = the original words (multilingual v2).
 */
const V4_ONLY = new Set(["af", "sw", "zu"]);
export function ttsModelFor(lang: string | null | undefined): string {
  return process.env.ELEVENLABS_TTS_MODEL || (lang && V4_ONLY.has(lang) ? "eleven_v4" : "eleven_multilingual_v2");
}

export async function textToSpeech(voiceId: string, text: string, model = ttsModelFor(null)): Promise<Uint8Array> {
  const res = await call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.1, use_speaker_boost: true },
    }),
  });
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteLegacyAgent(agentId: string): Promise<void> {
  try { await call(`/v1/convai/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }); }
  catch (e) { if (!(e instanceof ElevenLabsError && e.status === 404)) throw e; }
}

