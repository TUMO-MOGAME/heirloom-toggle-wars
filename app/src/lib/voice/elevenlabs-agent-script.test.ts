/** scripts/elevenlabs-agent.ts (plan §20.1): the dry run builds valid JSON, sends nothing and prints no secret. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgent, buildTools, main, SECRET_PLACEHOLDER, TTS_MODEL } from "../../../../scripts/elevenlabs-agent";
import { languagesFor, VOICE_LANGUAGES } from "./languages";

const KEY = "sk_test_never_print_me_0123456789";
const AGENT = "agent_test_never_print_me_0123";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the agent-as-code script", () => {
  it("dry run (the default) prints valid JSON, reads no key and calls no API", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", KEY);
    vi.stubEnv("ELEVENLABS_AGENT_ID", AGENT);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
    const argv = process.argv;
    process.argv = ["node", "elevenlabs-agent.ts"];
    try { await main(); } finally { process.argv = argv; }

    expect(fetchSpy).not.toHaveBeenCalled();
    const all = out.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(AGENT);
    const plan = JSON.parse(out[0]) as { dryRun: boolean; tools: { tool_config: { name: string } }[]; agent: unknown };
    expect(plan.dryRun).toBe(true);
    expect(plan.tools.map((t) => t.tool_config.name)).toEqual(["heirloom_orchestrate", "navigate", "open_claim_form", "show_rule", "start_upload"]);
  });

  it("the webhook header is a secret reference, never a value", () => {
    const [hook] = buildTools("https://example.org") as { api_schema: { url: string; request_headers: Record<string, unknown> } }[];
    expect(hook.api_schema.url).toBe("https://example.org/api/agent/orchestrate");
    expect(hook.api_schema.request_headers["x-heirloom-tool-secret"]).toEqual({ secret_id: SECRET_PLACEHOLDER });
  });

  it("the agent speaks every agent language, allows the language and first-message overrides, and is private", () => {
    const a = buildAgent({ baseUrl: "https://example.org", llm: "gemini-3.5-flash", toolIds: ["t1"] }) as {
      conversation_config: { tts: { model_id: string }; language_presets: Record<string, { overrides: { agent: { first_message: string } } }>; agent: { first_message: string; prompt: { tool_ids: string[]; prompt: string } } };
      platform_settings: { auth: { enable_auth: boolean }; overrides: { conversation_config_override: { agent: { first_message: boolean; language: boolean } } } };
    };
    expect(a.conversation_config.tts.model_id).toBe(TTS_MODEL);
    const presets = Object.keys(a.conversation_config.language_presets).sort();
    expect(presets).toEqual(languagesFor("agent").filter((l) => l !== "en").map((l) => VOICE_LANGUAGES[l].elevenlabs).sort());
    for (const p of Object.values(a.conversation_config.language_presets)) expect(p.overrides.agent.first_message).toContain("{{persona_name}}");
    expect(a.conversation_config.agent.first_message).toContain("{{persona_name}}");
    expect(a.conversation_config.agent.prompt.prompt).toContain("{{lang_name}}");
    expect(a.platform_settings.overrides.conversation_config_override.agent).toEqual({ first_message: true, language: true });
    expect(a.platform_settings.auth.enable_auth).toBe(true);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});
