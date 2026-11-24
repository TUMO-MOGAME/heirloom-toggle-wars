/**
 * The Heirloom voice agent as code (plan §20.1): creates or updates the ElevenLabs Agents Platform agent and its tools
 * through the REST API, so the set-up in scripts/elevenlabs-agent.md is reproducible.
 *
 *   npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/elevenlabs-agent.ts                     # DRY RUN (default)
 *   npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/elevenlabs-agent.ts --send              # create or update
 *   options: --url=https://heirloom-devnet.vercel.app   (the deployment the webhook calls)
 *            --llm=gemini-3.5-flash                      (an LLM id from the agent's LLM dropdown)
 *
 * DRY RUN prints the JSON it would send and reads no key. --send reads from process.env ONLY (never a file, never
 * printed): ELEVENLABS_API_KEY; ELEVENLABS_AGENT_ID (update that agent; unset = create one and print its new id);
 * ELEVENLABS_TOOL_SECRET_ID = the id of the workspace secret that holds ELEVENLABS_TOOL_SECRET (create it once in the
 * dashboard: Agents → Secrets), so the webhook header is a secret reference, never the value.
 *
 * API (docs checked 24 Nov 2026): POST /v1/convai/tools, GET /v1/convai/tools, PATCH /v1/convai/tools/{id},
 * POST /v1/convai/agents/create, PATCH /v1/convai/agents/{id}. https://elevenlabs.io/docs/api-reference/agents/create
 * The agent never signs or sends a transaction: its tools only explain (webhook) and drive the screen (client tools).
 */
import { pathToFileURL } from "node:url";
import { languagesFor, VOICE_LANGUAGES } from "../app/src/lib/voice/languages";
import { voiceScripts } from "../app/src/content/voice-scripts";

const API = "https://api.elevenlabs.io";
/** "Katlego – Warm & educational", a South African English library voice (scripts/elevenlabs-agent.md). */
export const VOICE_ID = "GWxVpgZHEljuUpLKSxHI";
/** Speaks every agent language in lib/voice/languages.ts, including af and sw (Flash v2.5 doesn't). */
export const TTS_MODEL = "eleven_v4_turbo";
export const SECRET_PLACEHOLDER = "<ELEVENLABS_TOOL_SECRET_ID>";

const NAVIGATE_PATHS = ["/chat", "/estate", "/will", "/vault", "/claims", "/family", "/inbox", "/car", "/hardship", "/send", "/people", "/legacy"];

export const SYSTEM_PROMPT = `You are the voice of Heirloom, a programmable estate trust for South African families. Money is USD₮ (Tether)
in a Solana vault; a smart contract enforces caps, floor prices and verifier quorums. You never move money and
you never ask for seed phrases, PINs, ID numbers or bank details.

Caller: {{persona}}. Estate: {{estate}}. Screen: {{page}}. Spoken language: {{lang_name}}.

How to work:
- Speak {{lang_name}} for the whole call: the caller chose it. Keep amounts, "USD₮", "Heirloom" and people's and
  institutions' names as they are.
- For ANY question about the will, documents, claims, payouts, the car, offers, the estate's status, privacy or
  legality, call the server tool \`heirloom_orchestrate\` with the caller's words (rephrase only to make it complete).
  It answers in {{lang_name}}. Speak its \`reply\` naturally. Do not invent facts the tool did not give you.
- The app applies the tool's \`actions\` automatically. Only call a client tool yourself when the caller directly
  asks to go somewhere or open something and you did not just call \`heirloom_orchestrate\` for it.
- Keep answers to 1–3 short sentences. Say amounts like "four thousand U S D T" and mention rand only if the
  tool gave a rand figure.
- Tone: warm, patient, respectful; many callers are grieving. If the caller greets you in isiZulu or Sesotho, greet
  back in that language (e.g. "Sawubona" / "Dumela"), then continue in {{lang_name}}.
- If the tool says something needs a human (needsHuman), tell the caller a verifier or the executor must decide.
- Sending money: Heirloom has "Send to family". The caller sends USD₮ to a saved family member themselves on the
  Send money screen (/send): they review the amount, network and fee, then approve and sign with their own wallet, and
  Heirloom pays the network fee. If they ask you to send money, say you can't send it for them, then offer to open the
  Send money screen and call the client tool \`navigate\` with path "/send" when they agree.
- Facts: the tool already has the caller's estate (vault, rules, caps, trusted people, car). Trust its numbers.
- Never say you are checking or looking something up unless you call \`heirloom_orchestrate\` in that SAME turn.
  Never end your turn on "one moment" or "let me check": either call the tool now or answer.
- If the caller repeats a question you said you would check, call the tool straight away.
- Estate "none" means no plan has been signed for this family yet. If the tool says so, explain kindly that the parent
  must first finish and sign the plan on the Plan screen; never ask the caller to "open" or "unlock" an estate.
- Tone tags: at most one, at the very start of a reply (for example [warm]), never followed by punctuation.
- Heirloom does not replace a signed paper will; say so if asked.`;

type Json = Record<string, unknown>;
const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const dyn = (name: string, description: string) => ({ type: "string", description, dynamic_variable: name });

/** The five tools: one webhook (the orchestrator) and four client tools (lib/voice/useHeirloomVoice.ts). */
export function buildTools(baseUrl: string, secretId: string = SECRET_PLACEHOLDER): Json[] {
  const url = new URL("/api/agent/orchestrate", baseUrl).toString();
  return [
    {
      type: "webhook",
      name: "heirloom_orchestrate",
      description: "Ask Heirloom's specialist agents about the will, documents, claims, the car sale, estate status, privacy or legality. Returns what to say and UI actions.",
      response_timeout_secs: 20,
      api_schema: {
        url,
        method: "POST",
        content_type: "application/json",
        request_headers: { "x-heirloom-tool-secret": { secret_id: secretId } },
        request_body_schema: {
          type: "object",
          description: "The caller's request and the call's context.",
          properties: {
            message: str("The caller's request in full, in their own words."),
            persona: dyn("persona", "Who is calling"),
            estate: dyn("estate", "Estate address or none"),
            page: dyn("page", "The screen the caller is on"),
            facts: dyn("facts", "The screen's estate facts as JSON"),
            lang: dyn("lang", "The call's spoken language; the reply comes back in it"),
            conversation_id: dyn("system__conversation_id", "The conversation id"),
          },
          required: ["message"],
        },
      },
    },
    {
      type: "client", name: "navigate", description: "Open a screen in the Heirloom app.", expects_response: true, response_timeout_secs: 10,
      parameters: { type: "object", properties: { path: str("The screen to open", { enum: NAVIGATE_PATHS }) }, required: ["path"] },
    },
    {
      type: "client", name: "open_claim_form", description: "Open the claim form prefilled.", expects_response: true, response_timeout_secs: 10,
      parameters: {
        type: "object",
        properties: { rule: str("Rule address"), payee: str("Payee wallet"), amount: { type: "number", description: "Amount in USD₮" } },
        required: [],
      },
    },
    {
      type: "client", name: "show_rule", description: "Highlight one payout rule on screen.", expects_response: true, response_timeout_secs: 10,
      parameters: { type: "object", properties: { rule: str("Rule address") }, required: ["rule"] },
    },
    {
      type: "client", name: "start_upload", description: "Open the document upload.", expects_response: true, response_timeout_secs: 10,
      parameters: { type: "object", properties: { purpose: str("What the document is for", { enum: ["death", "claim", "hardship"] }) }, required: ["purpose"] },
    },
  ];
}

const greeting = (lang: keyof typeof VOICE_LANGUAGES) => voiceScripts[lang]?.firstMessage.named.replace("{name}", "{{persona_name}}");

/** The agent body for create/update. `toolIds` are the ids of buildTools()' tools, in the same order. */
export function buildAgent(opts: { baseUrl: string; llm: string; toolIds: string[] }): Json {
  const host = new URL(opts.baseUrl).hostname;
  const extra = languagesFor("agent").filter((l) => l !== "en");
  return {
    name: "Heirloom",
    tags: ["heirloom"],
    conversation_config: {
      agent: {
        language: "en",
        first_message: greeting("en"),
        dynamic_variables: {
          dynamic_variable_placeholders: { persona: "guest", persona_name: "there", estate: "none", page: "/", facts: "none", lang: "en", lang_name: "English" },
        },
        prompt: {
          prompt: SYSTEM_PROMPT,
          llm: opts.llm,
          tool_ids: opts.toolIds,
          built_in_tools: {
            language_detection: { type: "system", name: "language_detection", description: "", params: { system_tool_type: "language_detection" } },
          },
        },
      },
      tts: { voice_id: VOICE_ID, model_id: TTS_MODEL, stability: 0.6 },
      // Every language the agent may speak (lib/voice/languages.ts support.agent), each with its own greeting.
      language_presets: Object.fromEntries(extra.map((l) => [VOICE_LANGUAGES[l].elevenlabs, { overrides: { agent: { first_message: greeting(l), language: null }, tts: null } }])),
      conversation: { client_events: ["audio", "interruption", "agent_response", "user_transcript", "agent_tool_response_full_payload"] },
    },
    platform_settings: {
      // A private agent: sessions need the signed URL from GET /api/voice/session; the API key never reaches the browser.
      auth: { enable_auth: true, allowlist: [{ hostname: host }] },
      // The app sends these two for a call in another language (lib/voice/useHeirloomVoice.ts voiceSessionOptions).
      overrides: { conversation_config_override: { agent: { first_message: true, language: true } } },
    },
  };
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

async function api(key: string, method: string, path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
  return text ? (JSON.parse(text) as Json) : {};
}

export async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const baseUrl = arg("url") ?? "https://heirloom-devnet.vercel.app";
  const llm = arg("llm") ?? "gemini-3.5-flash";

  if (!send) {
    const tools = buildTools(baseUrl);
    const agent = buildAgent({ baseUrl, llm, toolIds: tools.map((t) => `<id of ${String(t.name)}>`) });
    console.log(JSON.stringify({ dryRun: true, tools: tools.map((tool_config) => ({ tool_config })), agent }, null, 2));
    console.error("Dry run: nothing sent. Add --send to create or update the agent (reads ELEVENLABS_API_KEY from the environment).");
    return;
  }

  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const secretId = process.env.ELEVENLABS_TOOL_SECRET_ID;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set in the environment.");
  if (!secretId) throw new Error("ELEVENLABS_TOOL_SECRET_ID is not set: create a workspace secret holding ELEVENLABS_TOOL_SECRET and give its id.");

  const existing = ((await api(key, "GET", "/v1/convai/tools")).tools ?? []) as { id: string; tool_config?: { name?: string } }[];
  const toolIds: string[] = [];
  for (const tool_config of buildTools(baseUrl, secretId)) {
    const found = existing.find((t) => t.tool_config?.name === tool_config.name);
    const r = found
      ? await api(key, "PATCH", `/v1/convai/tools/${encodeURIComponent(found.id)}`, { tool_config })
      : await api(key, "POST", "/v1/convai/tools", { tool_config });
    toolIds.push(String(r.id ?? found?.id));
    console.log(`${found ? "updated" : "created"} tool ${String(tool_config.name)}`);
  }

  const agent = buildAgent({ baseUrl, llm, toolIds });
  if (agentId) {
    await api(key, "PATCH", `/v1/convai/agents/${encodeURIComponent(agentId)}`, agent);
    console.log("updated the agent in ELEVENLABS_AGENT_ID");
  } else {
    const r = await api(key, "POST", "/v1/convai/agents/create", agent);
    console.log(`created agent ${String(r.agent_id)}: set ELEVENLABS_AGENT_ID to it on the server`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
