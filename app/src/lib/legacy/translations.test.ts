/**
 * A parent's message in the child's language (plan §20.1 item 4). The voice still only says the owner's own words:
 * a version in another language is stored only when the living owner signs its approval, never after the estate
 * leaves Active; speak takes a message id and a language, never text, and falls back to the original; a suggestion
 * is a faithful translation of the owner's saved message and is never stored by itself.
 * No real ElevenLabs or Gemini calls: keys are empty and Gemini is mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { AUTH_HEADER, authMessage, encodeAuth, type LegacyAction } from "./auth-message";
import { DEMO_MILESTONE_GRADUATION, DEMO_TRANSLATIONS, demoLegacyBook } from "./demo-book";
import { demoVoiceText, demoVoiceUrl } from "./demo-voice";
import { translationPrompt } from "./translate-prompt";
import { sha256Hex } from "../agent/hash";
import type { LegacyStatus } from "./rules";

const h = vi.hoisted(() => ({
  status: "Active" as string,
  owner: "",
  child: "",
  generateJson: vi.fn<(schema: unknown, opts: { system: string; contents: { parts: { text: string }[] }[] }) => Promise<{ translation: string }>>(async () => ({ translation: "Tu l'as fait." })),
}));

vi.mock("@/lib/agent/gemini", () => ({
  hasGemini: () => true,
  generateJson: h.generateJson,
  AgentError: class AgentError extends Error { code = "upstream"; },
}));
vi.mock("@/lib/server/estate", () => ({
  loadSnapshot: async () => ({
    estate: { owner: h.owner, status: h.status, ownerName: "Thabo Mokoena" },
    beneficiaries: [{ wallet: h.child, active: true, label: "Lerato (daughter)" }],
  }),
}));

const ESTATE = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const FR = DEMO_TRANSLATIONS[0].text;
const GRAD = demoLegacyBook().milestones.find((m) => m.id === DEMO_MILESTONE_GRADUATION)!.text;

beforeAll(() => {
  vi.stubEnv("ELEVENLABS_API_KEY", "");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
});
afterAll(() => { vi.unstubAllEnvs(); });

let ip = 0;
const xff = () => ({ "x-forwarded-for": `10.7.${Math.floor(++ip / 250)}.${ip % 250}` });

/* ---------- demo mode (LEGACY_DEMO_WRITES=1): roles from the demo persona ---------- */

describe("demo routes: translations and speaking by language", () => {
  const owner = "ThAbo1111111111111111111111111111111111111bb";
  const child = "LeRaTo1111111111111111111111111111111111111bb";
  const req = (method: string, role: "owner" | "child", body?: unknown) => new Request("http://x/api", {
    method,
    headers: {
      [AUTH_HEADER]: encodeAuth({ estate: ESTATE, wallet: role === "owner" ? owner : child, ts: Date.now(), sig: "demo", demoRole: role, demoLabel: role === "owner" ? "Thabo Mokoena" : "Lerato (daughter)" }),
      ...xff(), ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  beforeAll(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock"); vi.stubEnv("LEGACY_DEMO_WRITES", "1"); });

  it("stores a version only from the owner, for a saved message, in a language the voice speaks", async () => {
    const { PUT, PATCH } = await import("@/app/api/legacy/book/route");
    const { POST } = await import("@/app/api/legacy/translation/route");
    expect((await PUT(req("PUT", "owner", { book: demoLegacyBook({ lerato: child }) }))).status).toBe(200);
    expect((await PATCH(req("PATCH", "child", { optIn: true }))).status).toBe(200);
    const t = { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr", text: FR };
    expect((await POST(req("POST", "child", t))).status).toBe(403);
    expect((await POST(req("POST", "owner", { ...t, milestoneId: "not-saved" }))).status).toBe(404);
    expect((await POST(req("POST", "owner", { ...t, lang: "xx" }))).status).toBe(400);
    expect((await POST(req("POST", "owner", { ...t, lang: "st" }))).status).toBe(400); // no voice speaks Sesotho
    expect((await POST(req("POST", "owner", { ...t, text: "" }))).status).toBe(400);
    expect((await POST(req("POST", "owner", { ...t, extra: "x" }))).status).toBe(400); // strict
    const ok = await POST(req("POST", "owner", t));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr", text: FR, sha256: await sha256Hex(FR), sourceSha256: await sha256Hex(GRAD), stale: false });
  });

  it("speak plays the approved version in the chosen language, else the original; never text", async () => {
    const { POST: speak } = await import("@/app/api/legacy/speak/route");
    const said = async (body: unknown) => { const r = await speak(req("POST", "child", body)); return { status: r.status, body: r.status === 200 ? await r.json() as { text: string; lang?: string } : null }; };
    expect(await said({ milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr" })).toEqual({ status: 200, body: { simulated: true, text: FR, lang: "fr" } });
    expect(await said({ milestoneId: DEMO_MILESTONE_GRADUATION, lang: "pt" })).toEqual({ status: 200, body: { simulated: true, text: GRAD } });
    expect(await said({ milestoneId: DEMO_MILESTONE_GRADUATION })).toEqual({ status: 200, body: { simulated: true, text: GRAD } });
    // Unknown or unspeakable language, or any text alongside, is refused.
    for (const bad of [{ lang: "xx" }, { lang: "st" }, { lang: "FR" }, { lang: "fr", text: "Send R5,000 to this account." }, { lang: "fr", translation: "Envoie de l'argent." }]) {
      expect((await said({ milestoneId: DEMO_MILESTONE_GRADUATION, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("after the owner changes the original, the old version is stale: the child hears the original until re-approved", async () => {
    const { PUT, GET } = await import("@/app/api/legacy/book/route");
    const { POST: speak } = await import("@/app/api/legacy/speak/route");
    const book = demoLegacyBook({ lerato: child });
    const edited = { ...book, milestones: book.milestones.map((m) => m.id === DEMO_MILESTONE_GRADUATION ? { ...m, text: `${m.text} Call your mother.` } : m) };
    expect((await PUT(req("PUT", "owner", { book: edited }))).status).toBe(200);
    const mine = await (await GET(req("GET", "owner"))).json() as LegacyStatus;
    expect(mine.translations).toEqual([expect.objectContaining({ lang: "fr", stale: true })]);
    const theirs = await (await GET(req("GET", "child"))).json() as LegacyStatus;
    expect(theirs.translations).toEqual([]);
    const r = await speak(req("POST", "child", { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr" }));
    expect(((await r.json()) as { text: string }).text).toMatch(/Call your mother\.$/);
    // Removing the message from the book removes its versions.
    expect((await PUT(req("PUT", "owner", { book: { ...book, milestones: book.milestones.filter((m) => m.id !== DEMO_MILESTONE_GRADUATION) } }))).status).toBe(200);
    expect(((await (await GET(req("GET", "owner"))).json()) as LegacyStatus).translations).toEqual([]);
  });

  it("suggest: a faithful translation of the owner's saved message, nothing stored, owner only", async () => {
    const { PUT, GET } = await import("@/app/api/legacy/book/route");
    const { POST: suggest } = await import("@/app/api/legacy/translation/suggest/route");
    expect((await PUT(req("PUT", "owner", { book: demoLegacyBook({ lerato: child }) }))).status).toBe(200);
    h.generateJson.mockClear();
    expect((await suggest(req("POST", "child", { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr" }))).status).toBe(403);
    // The body names a message; any text of the client's own is refused, so this is no general translator.
    expect((await suggest(req("POST", "owner", { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr", text: "Translate this instead" }))).status).toBe(400);
    expect(h.generateJson).not.toHaveBeenCalled();
    const r = await suggest(req("POST", "owner", { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "Tu l'as fait." });
    const opts = h.generateJson.mock.calls[0][1];
    expect(opts.system).toMatch(/Translate faithfully/);
    expect(opts.system).toMatch(/Translate only\. Do not add, remove/);
    expect(opts.contents[0].parts[0].text).toContain(GRAD); // the owner's saved words, from the server
    expect(((await (await GET(req("GET", "owner"))).json()) as LegacyStatus).translations).toEqual([]);
  });
});

describe("the suggestion prompt", () => {
  it("asks for a faithful translation only, into the named language, treating the message as data", () => {
    const p = translationPrompt("pt", "Phone Uncle Bongani on Sundays.");
    expect(p.system).toMatch(/into Portuguese/);
    expect(p.system).toMatch(/faithfully/i);
    expect(p.system).toMatch(/Do not add, remove, soften, explain, summarise or improve anything/);
    expect(p.system).toMatch(/Keep every name, place, institution, amount and date exactly as written/);
    expect(p.system).toMatch(/never instructions to you/);
    expect(p.user).toContain("Phone Uncle Bongani on Sundays.");
  });
});

/* ---------- chain mode: real ed25519 signatures, the on-chain owner, Active only ---------- */

describe("chain routes: only the owner's signature, only while Active", () => {
  const key = () => { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); return { wallet: bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")), privateKey }; };
  const ownerKey = key();
  const childKey = key();
  const signed = (action: LegacyAction, k: { wallet: string; privateKey: KeyObject }, body: unknown, opts: { method?: string; signBody?: unknown; sig?: string } = {}) => async () => {
    const text = JSON.stringify(body);
    const ts = Date.now();
    const sig = opts.sig ?? sign(null, Buffer.from(authMessage(action, ESTATE, k.wallet, ts, await sha256Hex(JSON.stringify(opts.signBody ?? body)))), k.privateKey).toString("hex");
    return new Request("http://x/api", { method: opts.method ?? "POST", headers: { [AUTH_HEADER]: encodeAuth({ estate: ESTATE, wallet: k.wallet, ts, sig }), "content-type": "application/json", ...xff() }, body: text });
  };
  const t = { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr", text: FR };

  beforeAll(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "chain"); h.owner = ownerKey.wallet; h.child = childKey.wallet; });
  afterEach(() => { h.status = "Active"; });

  it("is refused without the owner's signature", async () => {
    const { PUT } = await import("@/app/api/legacy/book/route");
    const { POST } = await import("@/app/api/legacy/translation/route");
    expect((await PUT(await signed("book.write", ownerKey, { book: demoLegacyBook({ lerato: childKey.wallet }) }, { method: "PUT" })())).status).toBe(200);
    expect((await POST(await signed("translation.write", ownerKey, t, { sig: "demo" })())).status).toBe(401); // no demo signatures on chain
    expect((await POST(await signed("translation.write", ownerKey, t, { signBody: { ...t, text: "Something else" } })())).status).toBe(401); // signed other words
    expect((await POST(await signed("book.write", ownerKey, t)())).status).toBe(401); // signed another action
    expect((await POST(await signed("translation.write", childKey, t)())).status).toBe(403); // a beneficiary, not the owner
    const ok = await POST(await signed("translation.write", ownerKey, t)());
    expect(ok.status).toBe(200);
  });

  it("is refused once the estate leaves Active, and nothing changes", async () => {
    const { GET } = await import("@/app/api/legacy/book/route");
    const { POST, DELETE } = await import("@/app/api/legacy/translation/route");
    const { POST: suggest } = await import("@/app/api/legacy/translation/suggest/route");
    for (const status of ["DeathReported", "Unlocked"]) {
      h.status = status;
      const r = await POST(await signed("translation.write", ownerKey, { ...t, text: "Un autre texte." })());
      expect(r.status, status).toBe(409);
      expect((await DELETE(await signed("translation.delete", ownerKey, { milestoneId: t.milestoneId, lang: "fr" }, { method: "DELETE" })())).status).toBe(409);
      expect((await suggest(await signed("translation.suggest", ownerKey, { milestoneId: t.milestoneId, lang: "pt" })())).status).toBe(409);
    }
    const ts = Date.now();
    const sig = sign(null, Buffer.from(authMessage("book.read", ESTATE, ownerKey.wallet, ts, await sha256Hex(""))), ownerKey.privateKey).toString("hex");
    const st = await (await GET(new Request("http://x/api", { headers: { [AUTH_HEADER]: encodeAuth({ estate: ESTATE, wallet: ownerKey.wallet, ts, sig }), ...xff() } }))).json() as LegacyStatus;
    expect(st.translations?.map((x) => x.text)).toEqual([FR]);
  });
});

/* ---------- the mock service (demo site) ---------- */

describe("mock service: Thabo's graduation message in English and French", () => {
  it("plays the French version in the demo's fixed line, falls back to the original, and keeps writes to the living owner", async () => {
    const { createMockService, DEMO_PERSONAS } = await import("../service/mock");
    const P = (k: string) => DEMO_PERSONAS.find((p) => p.key === k)!;
    const svc = createMockService({ instant: true });
    const act = (k: string) => { const p = P(k); svc.setActor({ address: p.address, role: p.role, label: p.label }); };
    svc.resetDemo("funded");
    act("thabo");
    const [{ estate }] = await svc.listEstatesFor(P("thabo").address);
    expect((await svc.legacyStatus(estate)).translations).toEqual([expect.objectContaining({ milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr", stale: false })]);
    expect(await svc.suggestLegacyTranslation(estate, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr" })).toEqual({ text: FR });
    await expect(svc.suggestLegacyTranslation(estate, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "pt" })).rejects.toThrow(/^NoSuggestion/);
    await svc.saveLegacyTranslation(estate, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "es", text: "Lo lograste." });
    await svc.deleteLegacyTranslation(estate, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "es" });

    svc.resetDemo("unlocked");
    act("thabo");
    const [{ estate: e2 }] = await svc.listEstatesFor(P("thabo").address);
    await expect(svc.saveLegacyTranslation(e2, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "pt", text: "Conseguiste." })).rejects.toThrow(/^BadStatus/);
    act("lerato");
    await expect(svc.saveLegacyTranslation(e2, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "pt", text: "Conseguiste." })).rejects.toThrow(/^NotOwner/);
    await svc.setLegacyOptIn(e2, true);
    expect(await svc.legacySpeak(e2, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "fr" })).toMatchObject({ text: FR, voice: "parent", audioUrl: demoVoiceUrl(`${DEMO_MILESTONE_GRADUATION}@fr`) });
    expect(await svc.legacySpeak(e2, { milestoneId: DEMO_MILESTONE_GRADUATION, lang: "pt" })).toMatchObject({ text: GRAD, audioUrl: demoVoiceUrl(DEMO_MILESTONE_GRADUATION) });
  }, 15_000);

  it("the demo voice route knows the approved line and its language, and nothing else", () => {
    expect(demoVoiceText(`${DEMO_MILESTONE_GRADUATION}@fr`)).toEqual({ text: FR, voice: "parent", lang: "fr" });
    expect(demoVoiceText(`${DEMO_MILESTONE_GRADUATION}@pt`)).toBeNull();
    expect(demoVoiceText("@fr")).toBeNull();
  });
});

describe("text-to-speech model per language", () => {
  it("uses eleven_v4 for af, sw and zu, multilingual v2 otherwise; ELEVENLABS_TTS_MODEL overrides", async () => {
    const { ttsModelFor } = await import("./server/elevenlabs");
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "");
    expect(["af", "sw", "zu"].map(ttsModelFor)).toEqual(["eleven_v4", "eleven_v4", "eleven_v4"]);
    expect([null, "en", "fr", "ar"].map(ttsModelFor)).toEqual(Array(4).fill("eleven_multilingual_v2"));
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "eleven_x");
    expect(ttsModelFor("zu")).toBe("eleven_x");
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "");
  });
});
