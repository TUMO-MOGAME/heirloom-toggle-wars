/**
 * Plan §20.1 "One agent, many languages": the call sends the ElevenLabs language and first-message overrides, the
 * webhook answers in the call's language, and the picker only offers what ElevenLabs can do. Model and network faked.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Language } from "@elevenlabs/react";
import { firstMessageFor, scriptFor, voiceScripts } from "@/content/voice-scripts";
import { languagesFor, VOICE_LANGUAGES, VOICE_LANGUAGE_CODES } from "./languages";
import { voiceSessionOptions } from "./useHeirloomVoice";
import { VoiceLanguagePicker, voicePickerOptions } from "@/components/agent/voice-language-picker";

const h = vi.hoisted(() => ({ systems: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/shared-store", () => ({ takeShared: async () => null, claimSharedOnce: async () => null }));
vi.mock("@/lib/db", async (original: () => Promise<object>) => ({ ...(await original()), saveTranscript: async () => undefined }));
vi.mock("@/lib/agent/gemini", async (original: () => Promise<object>) => ({
  ...(await original()),
  hasGemini: () => true,
  generate: async (o: { system: string }) => { h.systems.push(o.system); return { text: "ok", functionCalls: [] }; },
}));

describe("the voice session (useHeirloomVoice)", () => {
  const ctx = { persona: "owner:Thabo Mokoena", estate: "none", page: "/estate" };

  it("sends the language and a first message in it, for a language other than English", () => {
    const o = voiceSessionOptions({ ...ctx, lang: "fr" }, firstMessageFor);
    expect(o.overrides?.agent.language).toBe("fr");
    expect(o.overrides?.agent.firstMessage).toBe(firstMessageFor("fr", "Thabo"));
    expect(o.overrides?.agent.firstMessage).toMatch(/^Bonjour Thabo/);
    expect(o.dynamicVariables).toMatchObject({ lang: "fr", lang_name: "French", persona_name: "Thabo" });
  });

  it("sends no overrides in English, so an agent without overrides allowed keeps working", () => {
    const o = voiceSessionOptions(ctx, firstMessageFor);
    expect(o.overrides).toBeUndefined();
    expect(o.dynamicVariables.lang).toBe("en");
  });

  it("never asks the agent for a language it can't speak", () => {
    for (const lang of VOICE_LANGUAGE_CODES) {
      const o = voiceSessionOptions({ ...ctx, lang }, firstMessageFor);
      expect(VOICE_LANGUAGES[o.dynamicVariables.lang as typeof lang].support.agent).toBe(true);
    }
    expect(voiceSessionOptions({ ...ctx, lang: "st" }, firstMessageFor).overrides).toBeUndefined();
  });

  it("greets a guest without a name", () => {
    expect(voiceSessionOptions({ persona: "guest", lang: "es" }, firstMessageFor).overrides?.agent.firstMessage).toBe(voiceScripts.es?.firstMessage.guest);
  });

  it("uses only codes in ElevenLabs' agent language list (type-checked against the SDK)", () => {
    const sdk: Language[] = ["en", "fr", "pt", "es", "ar", "hi", "zh", "af", "sw"];
    for (const l of languagesFor("agent")) expect(sdk).toContain(VOICE_LANGUAGES[l].elevenlabs);
  });
});

describe("the simulated call", () => {
  it("has a script and greeting for every language the agent speaks, marked when machine translated", () => {
    for (const l of languagesFor("agent")) {
      const s = voiceScripts[l];
      expect(s, l).toBeDefined();
      expect(s!.preview.length).toBe(voiceScripts.en!.preview.length);
      expect(s!.preview.map((p) => p.role)).toEqual(voiceScripts.en!.preview.map((p) => p.role));
      expect(s!.firstMessage.named).toContain("{name}");
      expect(s!.firstMessage.guest).not.toContain("{name}");
      expect(s!.firstMessage.named).toContain("Heirloom");
      if (l !== "en") expect(s!.translated).toBe("machine");
    }
    expect(scriptFor("st").lang).toBe("en");
  });
});

describe("the webhook (POST /api/agent/orchestrate)", () => {
  let POST: (req: Request) => Promise<Response>;
  beforeAll(async () => {
    process.env.ELEVENLABS_TOOL_SECRET = "test-secret-for-the-webhook";
    ({ POST } = await import("@/app/api/agent/orchestrate/route"));
  });
  beforeEach(() => { h.systems = []; });
  let ip = 0;
  const call = (body: object, voice = true) => POST(new Request("http://t/api/agent/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++ip}`, ...(voice ? { "x-heirloom-tool-secret": "test-secret-for-the-webhook" } : {}) },
    body: JSON.stringify(body),
  }));

  it("tells the specialist to reply in the call's spoken language", async () => {
    const res = await call({ message: "What happens to the vault?", persona: "owner:Thabo", lang: "fr" });
    expect(res.status).toBe(200);
    expect(h.systems.at(-1)).toContain("the user chose French");
  });

  it("the call's language wins over the app's", async () => {
    await call({ message: "What happens to the vault?", locale: "af", lang: "sw" });
    expect(h.systems.at(-1)).toContain("the user chose Swahili");
  });

  it("keeps the UI locales' names (text chat)", async () => {
    await call({ text: "What happens to the vault?", locale: "st", specialist: "EstateGuide" }, false);
    expect(h.systems.at(-1)).toContain("Sesotho (Southern Sotho, as spoken in South Africa)");
  });

  it("ignores an unknown or empty language and answers in English", async () => {
    const res = await call({ message: "What happens to the vault?", lang: "none" });
    expect(res.status).toBe(200);
    expect(h.systems.at(-1)).not.toContain("the user chose");
  });
});

describe("the spoken-language picker", () => {
  it("lists only languages the agent can speak, plus 'Same as the app'", () => {
    const html = renderToStaticMarkup(createElement(VoiceLanguagePicker));
    for (const l of VOICE_LANGUAGE_CODES) {
      const listed = html.includes(`value="${l}"`);
      expect(listed, l).toBe(VOICE_LANGUAGES[l].support.agent);
    }
    expect(html).toContain('value=""');
    expect(html).toContain("Same as the app (English)");
  });

  it("marks Arabic right to left", () => {
    const html = renderToStaticMarkup(createElement(VoiceLanguagePicker));
    expect(html).toMatch(/<option value="ar" lang="ar" dir="rtl">/);
  });

  it("hides unsupported languages for each capability", () => {
    expect(voicePickerOptions("agent").map((o) => o.value)).not.toContain("zu");
    expect(voicePickerOptions("agent").map((o) => o.value)).not.toContain("st");
    expect(voicePickerOptions("listen").map((o) => o.value)).not.toContain("st");
  });
});

describe("the speech model", () => {
  it("is Eleven v4 for af, sw and zu, Multilingual v2 otherwise", async () => {
    const { speechModelFor } = await import("./languages");
    expect(["af", "sw", "zu"].map((l) => speechModelFor(l as "af"))).toEqual(["eleven_v4", "eleven_v4", "eleven_v4"]);
    expect(speechModelFor("fr")).toBe("eleven_multilingual_v2");
  });
});
