/**
 * Browser client for /api/legacy/*. Every call is signed by the acting wallet
 * (see ./auth-message.ts). Used by service/chain.ts (real WDK signatures) and by service/mock.ts on a demo
 * deployment that enables LEGACY_DEMO_WRITES (sig "demo", role from the demo persona).
 */
import { sha256Hex } from "../agent/hash";
import { AUTH_HEADER, authMessage, encodeAuth, type LegacyAction } from "./auth-message";
import type { LegacyBook, LegacySpeech, LegacyStatus, LegacyTranslation, LegacyVoiceInfo, TranslationInput, TranslationKey } from "./schema";
import type { VoiceLanguage } from "../voice/languages";

export interface LegacySigner {
  estate: string;
  wallet: string;
  /** Returns a hex ed25519 signature, or "demo" on a demo deployment. */
  sign(message: string): Promise<string>;
  /** False when signing would ask for something (the PIN, a phone wallet app). Absent: assume it can. */
  canSignQuietly?(): boolean;
  demoRole?: "owner" | "child";
  demoLabel?: string;
}

export interface LegacyVoiceUpload { ownerName: string; consentText: string; consentAccepted: boolean; consent: Blob; samples: Blob[] }
/**
 * The only things the voice may say: a milestone message the owner wrote (in `lang` when the owner approved a version
 * in that language, else the original), or the fixed sample line (owner). Never text.
 */
export type SpeakInput = { milestoneId: string; lang?: VoiceLanguage } | { sample: true } | { disclosure: true };

async function header(s: LegacySigner, action: LegacyAction, bodyHash: string): Promise<Record<string, string>> {
  const ts = Date.now();
  const sig = await s.sign(authMessage(action, s.estate, s.wallet, ts, bodyHash));
  return { [AUTH_HEADER]: encodeAuth({ estate: s.estate, wallet: s.wallet, ts, sig, demoRole: s.demoRole, demoLabel: s.demoLabel }) };
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const err = new Error(data.error ?? `Request failed (${res.status})`) as Error & { code?: string; status?: number };
  err.code = data.code; err.status = res.status;
  throw err;
}

async function send<T>(s: LegacySigner, action: LegacyAction, method: string, path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(path, {
    method, cache: "no-store",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(await header(s, action, await sha256Hex(text))) },
    body: body === undefined ? undefined : text,
  });
  return (await check(res)).json() as Promise<T>;
}

const blobHash = async (b: Blob) => sha256Hex(new Uint8Array(await b.arrayBuffer()));
const ext = (t: string) => (t.includes("ogg") ? "ogg" : t.includes("mp4") ? "m4a" : t.includes("wav") ? "wav" : t.includes("mpeg") ? "mp3" : "webm");

export const legacyApi = {
  async probe(): Promise<{ elevenlabs: boolean; available: boolean }> {
    const res = await fetch("/api/legacy/voice", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return { elevenlabs: false, available: false };
    return res.json() as Promise<{ elevenlabs: boolean; available: boolean }>;
  },
  /**
   * The book and voice status. `quiet` is for background reads (the chat home's legacy card): if signing would ask
   * for the PIN, it fails at once with code "locked" instead, and nothing is sent.
   */
  status: (s: LegacySigner, opts: { quiet?: boolean } = {}) => {
    if (opts.quiet && s.canSignQuietly?.() === false) {
      return Promise.reject(Object.assign(new Error("The wallet is locked."), { code: "locked" }));
    }
    return send<LegacyStatus>(s, "book.read", "GET", "/api/legacy/book");
  },
  saveBook: async (s: LegacySigner, book: LegacyBook) => (await send<{ book: LegacyBook }>(s, "book.write", "PUT", "/api/legacy/book", { book })).book,
  deleteBook: async (s: LegacySigner) => { await send(s, "book.delete", "DELETE", "/api/legacy/book"); },
  optIn: async (s: LegacySigner, on: boolean) => { await send(s, "optin", "PATCH", "/api/legacy/book", { optIn: on }); },
  deleteVoice: async (s: LegacySigner) => { await send(s, "voice.delete", "DELETE", "/api/legacy/voice"); },
  /** Owner: approve these exact words for one message in one language (wallet-signed). */
  saveTranslation: (s: LegacySigner, t: TranslationInput) => send<LegacyTranslation>(s, "translation.write", "POST", "/api/legacy/translation", t),
  deleteTranslation: async (s: LegacySigner, k: TranslationKey) => { await send(s, "translation.delete", "DELETE", "/api/legacy/translation", k); },
  /** Owner: a machine suggestion of their own message in `lang`. Nothing is stored. */
  suggestTranslation: (s: LegacySigner, k: TranslationKey) => send<{ text: string }>(s, "translation.suggest", "POST", "/api/legacy/translation/suggest", k),

  async createVoice(s: LegacySigner, u: LegacyVoiceUpload): Promise<LegacyVoiceInfo> {
    const [consentSha, ...sampleShas] = await Promise.all([blobHash(u.consent), ...u.samples.map(blobHash)]);
    const bodyHash = await sha256Hex(JSON.stringify({ ownerName: u.ownerName, consentText: u.consentText, consent: consentSha, samples: sampleShas }));
    const form = new FormData();
    form.set("ownerName", u.ownerName);
    form.set("consentText", u.consentText);
    form.set("consentAccepted", String(u.consentAccepted));
    form.set("consent", u.consent, `consent.${ext(u.consent.type)}`);
    u.samples.forEach((b, i) => form.append("samples", b, `sample-${i + 1}.${ext(b.type)}`));
    const res = await fetch("/api/legacy/voice", { method: "POST", body: form, headers: await header(s, "voice.create", bodyHash) });
    return (await check(res)).json() as Promise<LegacyVoiceInfo>;
  },

  async speak(s: LegacySigner, input: SpeakInput): Promise<LegacySpeech> {
    const voice: LegacySpeech["voice"] = "disclosure" in input ? "heirloom" : "parent";
    const text = JSON.stringify(input);
    const res = await check(await fetch("/api/legacy/speak", {
      method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", ...(await header(s, "speak", await sha256Hex(text))) },
      body: text,
    }));
    if ((res.headers.get("content-type") ?? "").startsWith("audio/")) {
      const blob = await res.blob();
      return { text: "", audioUrl: URL.createObjectURL(blob), simulated: false, voice };
    }
    const data = (await res.json()) as { simulated: true; text: string };
    return { text: data.text, audioUrl: null, simulated: true, voice };
  },
};
