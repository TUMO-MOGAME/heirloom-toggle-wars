/**
 * Voice typing's route (plan §20.1 item 2): /api/voice/transcribe checks what it is sent, holds to its limits, calls
 * ElevenLabs Scribe with the right form and never echoes the audio or ElevenLabs' own reply. No real ElevenLabs calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/shared-store", () => ({ takeShared: async () => null, claimSharedOnce: async () => null }));

const { DAILY_CAPS } = await import("@/lib/api/http");
const route = await import("@/app/api/voice/transcribe/route");
const { extensionFor, fromScribeCode, isDictationType, listenLanguage } = await import("./transcribe");

let n = 0;
const nextIp = () => `10.77.${(++n >> 8) & 255}.${n & 255}`;
const clip = (type = "audio/webm;codecs=opus", bytes = 1_000) => new Blob([new Uint8Array(bytes).fill(7)], { type });
function post(opts: { audio?: Blob | null; language?: string; ip?: string; raw?: BodyInit; contentType?: string } = {}) {
  const ip = opts.ip ?? nextIp();
  if (opts.raw !== undefined) {
    return route.POST(new Request("http://t/api/voice/transcribe", { method: "POST", headers: { "x-forwarded-for": ip, "content-type": opts.contentType ?? "application/json" }, body: opts.raw }));
  }
  const form = new FormData();
  if (opts.audio !== null) form.set("audio", opts.audio ?? clip(), "speech");
  if (opts.language !== undefined) form.set("language", opts.language);
  return route.POST(new Request("http://t/api/voice/transcribe", { method: "POST", headers: { "x-forwarded-for": ip }, body: form }));
}

const calls: { url: string; init: RequestInit }[] = [];
let reply: () => Response = () => Response.json({ text: "  Leave the car to Lerato.  ", language_code: "eng", language_probability: 0.98, words: [] });

beforeEach(() => {
  calls.length = 0;
  reply = () => Response.json({ text: "  Leave the car to Lerato.  ", language_code: "eng", language_probability: 0.98, words: [] });
  vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
  vi.stubEnv("ELEVENLABS_STT_MODEL", "");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("POST /api/voice/transcribe", () => {
  it("sends the clip to Scribe with the right form fields and returns only { text, language }", async () => {
    const res = await post({ language: "zu" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Leave the car to Lerato.", language: "en" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const form = calls[0].init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v3");
    expect(form.get("language_code")).toBe("zu");
    expect(form.get("tag_audio_events")).toBe("false");
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/webm");
    expect(file.name).toBe("speech.webm");
    expect(file.size).toBe(1_000);
  });

  it("lets Scribe detect the language when none is given, or the chosen one can't be heard well", async () => {
    await post();
    await post({ language: "st" }); // Sesotho: support.listen is false
    for (const c of calls) expect((c.init.body as FormData).has("language_code")).toBe(false);
  });

  it("refuses a language that isn't one of Heirloom's", async () => {
    const res = await post({ language: "xx" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("checks the kind and size of the recording", async () => {
    expect((await post({ audio: clip("text/plain") })).status).toBe(415);
    expect((await post({ audio: clip("video/webm") })).status).toBe(415);
    expect((await post({ audio: clip("audio/webm", 2_000_001) })).status).toBe(413);
    expect((await post({ audio: clip("audio/webm", 0) })).status).toBe(400);
    expect((await post({ audio: null })).status).toBe(400);
    expect((await post({ raw: JSON.stringify({ audio: "x" }) })).status).toBe(415);
    expect(calls).toHaveLength(0);
    for (const t of ["audio/ogg;codecs=opus", "audio/mp4", "audio/wav"]) expect((await post({ audio: clip(t) })).status).toBe(200);
  });

  it("is 503 unavailable without a key, and says so on GET before the microphone is asked for", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "unavailable", code: "unavailable" });
    expect(calls).toHaveLength(0);
    expect(await (await route.GET(new Request("http://t", { headers: { "x-forwarded-for": nextIp() } }))).json()).toEqual({ available: false });
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    expect(await (await route.GET(new Request("http://t", { headers: { "x-forwarded-for": nextIp() } }))).json()).toEqual({ available: true });
  });

  it("never echoes the audio or ElevenLabs' reply when Scribe fails", async () => {
    reply = () => new Response("transcript: my ID number is 8001015009087", { status: 422 });
    const res = await post({ audio: new Blob(["AUDIO-BYTES-SECRET"], { type: "audio/webm" }) });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain("8001015009087");
    expect(body).not.toContain("AUDIO-BYTES-SECRET");
  });

  it("a success holds nothing but the words", async () => {
    const res = await post({ audio: new Blob(["AUDIO-BYTES-SECRET"], { type: "audio/webm" }) });
    expect(await res.text()).not.toContain("AUDIO-BYTES-SECRET");
  });

  it("holds one address to 10 clips a minute", async () => {
    const ip = "198.51.100.9";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post({ ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("takes from today's 'stt' cap, per address and in all", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 25, 8));
    const ip = "198.51.100.10";
    let last = 0;
    for (let i = 0; i < DAILY_CAPS.stt.perIp + 1; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      last = (await post({ ip })).status;
    }
    expect(last).toBe(429);
    expect(calls).toHaveLength(DAILY_CAPS.stt.perIp);
    expect(DAILY_CAPS.stt.all).toBeGreaterThan(DAILY_CAPS.stt.perIp);
  });
});

describe("voice typing helpers", () => {
  it("maps Scribe's ISO 639-1 and 639-3 codes to Heirloom's languages", () => {
    expect(fromScribeCode("en")).toBe("en");
    expect(fromScribeCode("zul")).toBe("zu");
    expect(fromScribeCode("afr")).toBe("af");
    expect(fromScribeCode("swa")).toBe("sw");
    expect(fromScribeCode("deu")).toBeNull();
    expect(fromScribeCode(undefined)).toBeNull();
  });
  it("only asks Scribe for a listen-capable language", () => {
    expect(listenLanguage("af")).toBe("af");
    expect(listenLanguage("st")).toBeNull();
    expect(listenLanguage("")).toBeNull();
    expect(() => listenLanguage("klingon")).toThrow();
  });
  it("knows the recorder types and their file extensions", () => {
    expect(isDictationType("audio/webm;codecs=opus")).toBe(true);
    expect(isDictationType("audio/mpeg")).toBe(false);
    expect(extensionFor("audio/x-wav")).toBe("wav");
    expect(extensionFor("audio/mp4")).toBe("mp4");
  });
});
