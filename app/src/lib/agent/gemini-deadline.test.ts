/** Plan §18.9 M2: the model's retries (two calls, each retried once) must end inside the route's time limit. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as number[], fail: true }));
vi.mock("server-only", () => ({}));
vi.mock("@google/genai", () => ({
  ThinkingLevel: { LOW: "low", MEDIUM: "medium", HIGH: "high" },
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { config: { abortSignal: AbortSignal } }) => {
        h.calls.push(Date.now());
        // Hold until the call's own timeout aborts it, then fail like a busy upstream.
        await new Promise((resolve) => req.config.abortSignal.addEventListener("abort", resolve));
        throw new Error("503 UNAVAILABLE: aborted");
      },
    };
  },
}));

const { generateJson } = await import("./gemini");
const { z } = await import("zod");

beforeEach(() => { vi.stubEnv("GEMINI_API_KEY", "test"); h.calls = []; });
afterEach(() => vi.unstubAllEnvs());

describe("a deadline bounds every attempt and retry", () => {
  it("answers by the deadline, however slow the model", async () => {
    const start = Date.now();
    const deadline = start + 3_000;
    await expect(generateJson(z.object({ a: z.string() }), { system: "s", contents: [], timeoutMs: 60_000, deadline })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now()).toBeLessThan(deadline + 500);
    expect(h.calls.every((t) => t < deadline)).toBe(true);
  });

  it("starts nothing when the time is already up", async () => {
    await expect(generateJson(z.object({ a: z.string() }), { system: "s", contents: [], deadline: Date.now() + 100 })).rejects.toMatchObject({ code: "timeout" });
    expect(h.calls).toHaveLength(0);
  });
});
