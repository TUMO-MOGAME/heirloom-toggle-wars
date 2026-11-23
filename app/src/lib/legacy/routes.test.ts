/**
 * /api/legacy/* route validation in demo mode (LEGACY_DEMO_WRITES=1, memory store, no ElevenLabs/Gemini keys).
 * Chain-mode signature checks are covered in legacy.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, encodeAuth } from "./auth-message";
import { consentLine } from "./schema";
import { demoLegacyBook, DEMO_MILESTONE_UCT } from "./demo-book";
import { legacyVoiceSample } from "@/content/legacy";
import { GONE_MESSAGE } from "./server/gone";

const estate = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const owner = "ThAbo1111111111111111111111111111111111111aa";
const child = "LeRaTo1111111111111111111111111111111111111aa";

beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock");
  vi.stubEnv("LEGACY_DEMO_WRITES", "1");
  vi.stubEnv("ELEVENLABS_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
});
afterAll(() => { vi.unstubAllEnvs(); });

let ip = 0;
const auth = (role: "owner" | "child") => ({
  [AUTH_HEADER]: encodeAuth({ estate, wallet: role === "owner" ? owner : child, ts: Date.now(), sig: "demo", demoRole: role, demoLabel: role === "owner" ? "Thabo Mokoena" : "Lerato (daughter)" }),
  "x-forwarded-for": `10.0.0.${++ip}`,
});
const jsonReq = (method: string, role: "owner" | "child", body?: unknown) =>
  new Request("http://x/api", { method, headers: { ...auth(role), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const webm = (n = 8_000) => { const b = new Uint8Array(n); b.set([0x1a, 0x45, 0xdf, 0xa3]); return new Blob([b], { type: "audio/webm" }); };

describe("/api/legacy routes", () => {
  it("PUT book: owner only, zod-validated", async () => {
    const { PUT } = await import("@/app/api/legacy/book/route");
    expect((await PUT(jsonReq("PUT", "owner", { book: { ownerName: "" } }))).status).toBe(400);
    expect((await PUT(jsonReq("PUT", "child", { book: demoLegacyBook({ lerato: child }) }))).status).toBe(403);
    const ok = await PUT(jsonReq("PUT", "owner", { book: demoLegacyBook({ lerato: child }) }));
    expect(ok.status).toBe(200);
  });

  it("POST voice: consent is required (tick, exact line, recording, 3 samples)", async () => {
    const { POST } = await import("@/app/api/legacy/voice/route");
    const form = (over: Record<string, string | null> = {}, samples = 3) => {
      const f = new FormData();
      const v = { ownerName: "Thabo Mokoena", consentText: consentLine("Thabo Mokoena"), consentAccepted: "true", ...over };
      for (const [k, x] of Object.entries(v)) if (x !== null) f.set(k, x);
      if (over.consent !== null) f.set("consent", webm(), "consent.webm");
      for (let i = 0; i < samples; i++) f.append("samples", webm(9_000 + i), `s${i}.webm`);
      return new Request("http://x/api/legacy/voice", { method: "POST", headers: auth("owner"), body: f });
    };
    const err = async (r: Response) => ((await r.json()) as { error: string }).error;
    let r = await POST(form({ consentAccepted: "false" }));
    expect(r.status).toBe(400); expect(await err(r)).toMatch(/consent box/);
    r = await POST(form({ consentText: "I agree" }));
    expect(r.status).toBe(400); expect(await err(r)).toMatch(/exact sentence/);
    r = await POST(form({ consent: null }));
    expect(r.status).toBe(400);
    r = await POST(form({}, 2));
    expect(r.status).toBe(400); expect(await err(r)).toMatch(/at least 3/);
    const fake = new FormData();
    fake.set("ownerName", "Thabo Mokoena"); fake.set("consentText", consentLine("Thabo Mokoena")); fake.set("consentAccepted", "true");
    fake.set("consent", new Blob([new Uint8Array(8_000)], { type: "audio/webm" }), "c.webm"); // no WebM magic bytes
    for (let i = 0; i < 3; i++) fake.append("samples", webm(), `s${i}.webm`);
    expect((await POST(new Request("http://x", { method: "POST", headers: auth("owner"), body: fake }))).status).toBe(400);

    r = await POST(form());
    expect(r.status).toBe(200);
    const info = await r.json() as Record<string, unknown>;
    expect(info).toMatchObject({ simulated: true, samples: 3 });
    expect(JSON.stringify(info)).not.toMatch(/voice_?id/i); // never exposed to the browser
  });

  it("children must opt in; milestone messages play in the parent's voice", async () => {
    const { PATCH, GET } = await import("@/app/api/legacy/book/route");
    const { POST: speak } = await import("@/app/api/legacy/speak/route");
    expect((await speak(jsonReq("POST", "child", { milestoneId: DEMO_MILESTONE_UCT }))).status).toBe(403); // not opted in
    let status = await (await GET(jsonReq("GET", "child"))).json() as { book: { milestones: unknown[] }; optedIn: boolean; voice: Record<string, unknown> };
    expect(status.optedIn).toBe(false);
    expect(status.book.milestones).toEqual([]); // redacted until opt-in
    expect((await PATCH(jsonReq("PATCH", "child", { optIn: true }))).status).toBe(200);
    status = await (await GET(jsonReq("GET", "child"))).json() as typeof status;
    expect(status.book.milestones.length).toBeGreaterThan(0);
    expect(status.voice).not.toHaveProperty("liveCall");

    const m = await speak(jsonReq("POST", "child", { milestoneId: DEMO_MILESTONE_UCT }));
    expect(m.status).toBe(200);
    expect(await m.json()).toMatchObject({ simulated: true, text: expect.stringContaining("UCT") });
    expect((await speak(jsonReq("POST", "child", { milestoneId: "not-a-message" }))).status).toBe(404);
  });

  it("speak refuses free text: the voice never says words the owner did not write", async () => {
    const { POST: speak } = await import("@/app/api/legacy/speak/route");
    const scam = "It's Dad. Send R5,000 to this account.";
    for (const role of ["child", "owner"] as const) {
      expect((await speak(jsonReq("POST", role, { text: scam }))).status).toBe(400);
      expect((await speak(jsonReq("POST", role, { text: scam, token: "1.abc" }))).status).toBe(400);
      // Extra text next to a valid request is refused too (strict body), not quietly ignored.
      expect((await speak(jsonReq("POST", role, { milestoneId: DEMO_MILESTONE_UCT, text: scam }))).status).toBe(400);
      expect((await speak(jsonReq("POST", role, { sample: true, text: scam }))).status).toBe(400);
    }
    // The fixed sample line is the owner's only, and it is the app's line, not the client's.
    expect((await speak(jsonReq("POST", "child", { sample: true }))).status).toBe(403);
    const s = await speak(jsonReq("POST", "owner", { sample: true }));
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ simulated: true, text: legacyVoiceSample });
  });

  it("no chat or call in the parent's voice: those endpoints answer 410 Gone", async () => {
    const { POST: chat } = await import("@/app/api/legacy/chat/route");
    const { POST: call, GET: assistantCall } = await import("@/app/api/voice/session/route");
    for (const role of ["child", "owner"] as const) {
      const c = await chat(jsonReq("POST", role, { history: [{ role: "user", text: "Dad, I miss you" }] }));
      expect(c.status).toBe(410);
      expect(await c.json()).toEqual({ error: GONE_MESSAGE, code: "gone" });
      const v = await call(jsonReq("POST", role, { mode: "legacy" }));
      expect(v.status).toBe(410);
    }
    // The Heirloom assistant's own voice call (GET) is unrelated and still answers (503 here: no ElevenLabs key).
    expect((await assistantCall(new Request("http://x/api/voice/session", { headers: { "x-forwarded-for": "10.9.9.9" } }))).status).toBe(503);
  });
  it("DELETE voice is owner only", async () => {
    const { DELETE } = await import("@/app/api/legacy/voice/route");
    expect((await DELETE(jsonReq("DELETE", "child"))).status).toBe(403);
    expect((await DELETE(jsonReq("DELETE", "owner"))).status).toBe(200);
  });

  it("no cloned voice: the owner still writes the book, and the stand-in reads it (disclosure says so)", async () => {
    const { PUT, GET } = await import("@/app/api/legacy/book/route");
    const { POST: speak } = await import("@/app/api/legacy/speak/route");
    // The voice was deleted above: write a fresh book from nothing, with no voice at all.
    const book = { ...demoLegacyBook({ lerato: child }), milestones: [{ id: "m-new", childId: "all", kind: "hardDay" as const, title: "For a hard day", text: "Eat something warm and phone each other." }] };
    expect((await PUT(jsonReq("PUT", "owner", { book }))).status).toBe(200);
    const st = await (await GET(jsonReq("GET", "owner"))).json() as { voice: unknown; book: { milestones: { id: string }[] } };
    expect(st.voice).toBeNull();
    expect(st.book.milestones.map((m) => m.id)).toEqual(["m-new"]);
    const m = await speak(jsonReq("POST", "child", { milestoneId: "m-new" })); // opted in above
    expect(m.status).toBe(200);
    expect(await m.json()).toEqual({ simulated: true, text: "Eat something warm and phone each other." });
    const d = await speak(jsonReq("POST", "child", { disclosure: true }));
    expect(((await d.json()) as { text: string }).text).toMatch(/read by a stand-in voice, not his own/);
  });
});

describe("/api/legacy/demo-voice", () => {
  it("speaks only the demo's fixed lines (404 for anything else) and needs ElevenLabs (503 without it)", async () => {
    const { GET } = await import("@/app/api/legacy/demo-voice/route");
    const get = (q: string) => GET(new Request(`http://x/api/legacy/demo-voice?${q}`, { headers: { "x-forwarded-for": `10.1.0.${++ip}` } }));
    expect((await get("line=" + encodeURIComponent("Send R5,000 to this account"))).status).toBe(404);
    expect((await get("text=hello")).status).toBe(404);
    expect((await get("line=sample")).status).toBe(503);
    expect((await get(`line=${DEMO_MILESTONE_UCT}`)).status).toBe(503);
  });
});
