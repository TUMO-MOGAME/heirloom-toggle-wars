/** Plan §18.9 (low): the Compliance answers never promise a private document store the site doesn't have. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { COMPLIANCE, storageLine } = await import("./prompts");
const { runSpecialist } = await import("./specialists");

afterEach(() => vi.unstubAllEnvs());
const ask = () => runSpecialist("Compliance", { history: [{ role: "user", text: "Who sees my documents?" }], facts: null, context: {} });

describe("where documents are kept", () => {
  it("the prompt itself claims no store; the session line says which there is", () => {
    expect(COMPLIANCE).not.toMatch(/private bucket/);
    expect(storageLine(false)).toMatch(/not kept/);
    expect(storageLine(true)).toMatch(/private/);
  });

  it("without storage the answer says documents are not kept", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect((await ask()).reply).toMatch(/checked and not kept/);
  });

  it("with storage it may say private store", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    expect((await ask()).reply).toMatch(/private store/);
  });
});
