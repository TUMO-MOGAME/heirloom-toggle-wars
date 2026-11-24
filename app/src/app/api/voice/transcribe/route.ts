import { dailyCap, handler, HttpError, json, rateLimit, rateLimitShared } from "@/lib/api/http";
import { DICTATION_MAX_BYTES, baseType, extensionFor, fromScribeCode, isDictationType, listenLanguage } from "@/lib/voice/transcribe";
import { VOICE_LANGUAGES } from "@/lib/voice/languages";

export const maxDuration = 30;

/**
 * Voice typing (plan §20.1 item 2): the browser records a clip after the person taps the microphone, and this turns it
 * into text with ElevenLabs Speech to Text (Scribe). The text goes back into the input box for the person to read and
 * edit; nothing is sent or signed by voice.
 *
 * ElevenLabs POST /v1/speech-to-text (multipart: model_id, file, language_code?, tag_audio_events) → { text,
 * language_code, … }. Docs checked 24 Nov 2026: https://elevenlabs.io/docs/api-reference/speech-to-text/convert and
 * https://elevenlabs.io/docs/overview/models (scribe_v3 is the current batch model; ELEVENLABS_STT_MODEL overrides it).
 *
 * Privacy: the audio is held in memory for the one call and never stored or logged; the transcript is not logged.
 */
const SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = () => process.env.ELEVENLABS_STT_MODEL || "scribe_v3";
const MAX_TEXT = 5_000;

const unavailable = () => new HttpError(503, "unavailable", "unavailable");

/** GET /api/voice/transcribe → { available }: whether voice typing is set up here, before asking for the microphone. */
export const GET = handler(async (req) => {
  rateLimit(req, "voice-transcribe-probe", 60);
  return json({ available: Boolean(process.env.ELEVENLABS_API_KEY) });
});

/**
 * POST /api/voice/transcribe (multipart: audio = WebM/Ogg/MP4/WAV up to ~2 MB, about a minute; language = optional
 * VoiceLanguage) → { text, language }. language is the VoiceLanguage Scribe heard, or null for any other.
 * A language Scribe can't hear well is left to Scribe to detect. 503 { error: "unavailable" } without a key.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "voice-transcribe", 10);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw unavailable();

  if (!/^multipart\/form-data/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "Send the recording as a form upload.", "type");
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > DICTATION_MAX_BYTES + 16 * 1024) throw new HttpError(413, "The recording is too long.", "too_large");
  const form = await req.formData().catch(() => { throw new HttpError(400, "Expected a form upload."); });
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) throw new HttpError(400, "No recording was sent.", "empty");
  if (audio.size > DICTATION_MAX_BYTES) throw new HttpError(413, "The recording is too long.", "too_large");
  if (!isDictationType(audio.type)) throw new HttpError(415, "That kind of recording isn't supported.", "type");
  const rawLang = form.get("language");
  let language;
  try { language = listenLanguage(typeof rawLang === "string" ? rawLang : null); }
  catch { throw new HttpError(400, "Unknown language.", "language"); }

  await dailyCap(req, "stt");

  const type = baseType(audio.type);
  const body = new FormData();
  body.set("model_id", MODEL());
  body.set("file", new Blob([await audio.arrayBuffer()], { type }), `speech.${extensionFor(type)}`);
  if (language) body.set("language_code", VOICE_LANGUAGES[language].elevenlabs);
  body.set("tag_audio_events", "false");

  let res: Response;
  try {
    res = await fetch(SCRIBE, { method: "POST", headers: { "xi-api-key": apiKey }, body, signal: AbortSignal.timeout(25_000), cache: "no-store" });
  } catch {
    throw new HttpError(504, "The speech service took too long. Please try again.", "upstream");
  }
  // Never echo ElevenLabs' body: it could hold the transcript.
  if (res.status === 401) throw unavailable();
  if (res.status === 429) throw new HttpError(503, "The speech service is busy. Please try again in a moment.", "busy", 10);
  if (!res.ok) throw new HttpError(502, `The speech service could not read that (${res.status}).`, "upstream");
  const data = (await res.json().catch(() => ({}))) as { text?: unknown; language_code?: unknown };
  const text = typeof data.text === "string" ? data.text.trim().slice(0, MAX_TEXT) : "";
  return json({ text, language: fromScribeCode(data.language_code) ?? language });
});
