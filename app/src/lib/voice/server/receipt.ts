import "server-only";
/**
 * Spoken receipts, server side (plan §20.1 item 3; the route is app/api/voice/receipt). The sentence is built here
 * from the payment's own facts, never from text the browser sends:
 *  - devnet: the transaction is read from the RPC; it must have succeeded and carry a payout event emitted by the
 *    Heirloom program itself (Anchor's EventParser only reads `Program data:` lines inside this program's own
 *    invocation, so another program can't fake one). Names come only from what the public record shows: an approved
 *    payee's on-chain label when it is a university or school (lib/chain/public-names.ts), and the rule's category.
 *    Landlords, other payees, family wallets and fallback recipients are said by their role, never a name.
 *  - demo: the `demo.` receipt id is checked against the demo's fixed tables (lib/voice/receipts.ts).
 * Audio comes from ElevenLabs text to speech and is cached by sha256(template version, words, language, voice).
 */
import { createHash } from "node:crypto";
import { EventParser } from "@anchor-lang/core";
import { PublicKey, type Connection } from "@solana/web3.js";
import { getCoder, getIdl } from "../../chain/idl";
import type { Raw } from "../../chain/decoders";
import { decodePayee, decodeRule } from "../../chain/decoders";
import { ownAccount } from "../../chain/reads";
import { payeePda } from "../../chain/pda";
import { isRoleOnly } from "../../chain/public-names";
import { VOICE_LANGUAGES, type VoiceLanguage } from "../languages";
import { RECEIPT_EVENTS, RECEIPT_TEMPLATE_VERSION, type ReceiptFacts, type ReceiptParty, type ReceiptWords } from "../receipts";

/** The slice of a Connection receipts read (tests pass a fake). */
export type ReceiptConn = Pick<Connection, "getTransaction" | "getAccountInfo">;

export class ReceiptError extends Error {
  constructor(public status: number, message: string, public code: string) { super(message); this.name = "ReceiptError"; }
}

const notReceipt = () => new ReceiptError(404, "That transaction is not a Heirloom payment.", "not_receipt");

function field(d: Raw, name: string): unknown {
  const want = name.replace(/_/g, "").toLowerCase();
  for (const k of Object.keys(d)) if (k.replace(/_/g, "").toLowerCase() === want) return d[k];
  return undefined;
}
function keyOf(d: Raw, name: string): string | null {
  const v = field(d, name);
  return v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as PublicKey).toBase58() : null;
}
function bigOf(d: Raw, name: string): bigint | null {
  const v = field(d, name);
  if (v === undefined || v === null) return null;
  try { return BigInt(String(v)); } catch { return null; }
}

/** One payout event found in a transaction's logs. */
export interface PayoutEvent { name: string; data: Raw }

/**
 * The payout events the Heirloom program emitted in a transaction, from its log lines. Empty when the transaction
 * failed, has no logs or emitted none. Pure: tests pass the logs.
 */
export function payoutEvents(tx: { meta?: { err?: unknown; logMessages?: string[] | null } | null } | null): PayoutEvent[] {
  if (!tx?.meta || tx.meta.err) return [];
  const logs = tx.meta.logMessages;
  if (!logs?.length) return [];
  const parser = new EventParser(new PublicKey(getIdl().address), getCoder());
  const out: PayoutEvent[] = [];
  try {
    for (const ev of parser.parseLogs(logs)) if (RECEIPT_EVENTS[ev.name]) out.push({ name: ev.name, data: ev.data as Raw });
  } catch { /* logs this IDL can't read: not a receipt */ }
  return out;
}

/** The wallet a payout event paid (or, for a sale, sent the money to). */
export function payoutWallet(ev: PayoutEvent): string | null {
  return ev.name === "ClaimPaid" || ev.name === "ScheduledPaid" ? keyOf(ev.data, "payee") : keyOf(ev.data, "recipient");
}

/** What to call a payee aloud: an institution's public label, else its role. */
export function payeeParty(payee: { name: string; kind: string } | null): ReceiptParty {
  if (!payee) return { role: "payee" };
  if (payee.name === "Family member's own wallet") return { role: "ownWallet" };
  if ((payee.kind === "University" || payee.kind === "School") && !isRoleOnly(payee.name) && payee.name.trim()) {
    // A label written by the owner: printable characters only, as long as the public page shows it.
    const name = payee.name.replace(/[^\p{L}\p{N} .,'&()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 64);
    if (name) return { name };
  }
  return { role: payee.kind === "Landlord" ? "landlord" : "payee" };
}

/**
 * The facts of the devnet payment in transaction `signature`. `payee` picks the payout when one transaction holds
 * several (the scheduler can batch); it must be a wallet the transaction itself paid.
 */
export async function chainReceiptFacts(signature: string, payee: string | undefined, conn: ReceiptConn, usdtZar: number | null): Promise<ReceiptFacts> {
  const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) throw new ReceiptError(404, "That transaction was not found on devnet.", "not_found");
  const events = payoutEvents(tx);
  const ev = payee ? events.find((e) => payoutWallet(e) === payee) : events[0];
  if (!ev) throw notReceipt();
  const amount = bigOf(ev.data, "amount");
  const ts = Number(bigOf(ev.data, "ts") ?? BigInt(tx.blockTime ?? 0));
  if (amount === null || amount <= 0n || !ts) throw notReceipt();
  const kind = RECEIPT_EVENTS[ev.name];
  const programId = new PublicKey(getIdl().address);

  if (kind === "claim" || kind === "scheduled") {
    const estate = keyOf(ev.data, "estate");
    const rule = keyOf(ev.data, "rule");
    const wallet = payoutWallet(ev);
    if (!estate || !rule || !wallet) throw notReceipt();
    const [ruleInfo, payeeInfo] = await Promise.all([
      conn.getAccountInfo(new PublicKey(rule), "confirmed"),
      conn.getAccountInfo(payeePda(programId, new PublicKey(estate), new PublicKey(wallet)), "confirmed"),
    ]);
    const ruleRaw = ownAccount("Rule", ruleInfo);
    // The rule must still be this estate's (an account of another estate never names this payment's purpose).
    const ruleOk = ruleRaw && keyOf(ruleRaw, "estate") === estate ? decodeRule(rule, ruleRaw) : null;
    const payeeRaw = ownAccount("Payee", payeeInfo);
    const payeeAcc = payeeRaw ? decodePayee("", payeeRaw) : null;
    return { kind, amount, ts, to: payeeParty(payeeAcc), ...(ruleOk ? { purpose: ruleOk.category } : {}), usdtZar };
  }
  if (kind === "fallback" || kind === "sweep") return { kind, amount, ts, to: { role: "recipient" }, usdtZar };

  // A sale: the money went into the estate's vault (proceeds_to = the estate) or to a family member.
  const assetAddr = keyOf(ev.data, "asset");
  const recipient = keyOf(ev.data, "recipient");
  if (!assetAddr || !recipient) throw notReceipt();
  const assetRaw = ownAccount("Asset", await conn.getAccountInfo(new PublicKey(assetAddr), "confirmed"));
  const estate = assetRaw ? keyOf(assetRaw, "estate") : null;
  return { kind, amount, ts, to: estate && estate === recipient ? { role: "vault" } : { role: "family" }, asset: "asset", usdtZar };
}

/* ----- audio ----- */

/**
 * Languages only ElevenLabs' newer model speaks (lead, checked 24 Nov 2026 at elevenlabs.io/docs/overview/models:
 * eleven_multilingual_v2 does not speak af, sw or zu; eleven_v4 does). Whether a language is spoken at all is still
 * decided by its `support.speech` flag in lib/voice/languages.ts; this only picks the model.
 */
const V4_ONLY: ReadonlySet<VoiceLanguage> = new Set<VoiceLanguage>(["af", "sw", "zu"]);

/** The text-to-speech model for `lang`: eleven_v4 where only it speaks the language, else ELEVENLABS_TTS_MODEL or v2. */
export function ttsModelFor(lang: VoiceLanguage): string {
  if (V4_ONLY.has(lang)) return "eleven_v4";
  return process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";
}

export const receiptCacheKey = (words: ReceiptWords, voice: string, model = ttsModelFor(words.lang)) =>
  createHash("sha256").update(JSON.stringify([RECEIPT_TEMPLATE_VERSION, words.speech, words.lang, voice, model])).digest("hex");

/**
 * ElevenLabs text to speech for a receipt: POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128 with the
 * model for the language and its ISO code (same endpoint as lib/legacy/server/elevenlabs.ts, which has no model choice).
 */
export async function speakReceipt(words: ReceiptWords, voice: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ElevenLabs is not configured.");
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: words.speech,
      model_id: ttsModelFor(words.lang),
      language_code: VOICE_LANGUAGES[words.lang].elevenlabs,
      voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ElevenLabs text to speech failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

const MAX_CACHED = 300;
const audioCache = new Map<string, Uint8Array>();

/** Cached audio, or null. */
export function cachedReceiptAudio(key: string): Uint8Array | null {
  return audioCache.get(key) ?? null;
}
export function cacheReceiptAudio(key: string, audio: Uint8Array): void {
  if (audioCache.size >= MAX_CACHED) audioCache.delete(audioCache.keys().next().value as string);
  audioCache.set(key, audio);
}
/** Test helper. */
export function _clearReceiptCache(): void { audioCache.clear(); }

const factsCache = new Map<string, ReceiptFacts>();
/** A transaction never changes once confirmed, so its facts are kept (the rate is applied again on each use). */
export async function chainReceiptFactsCached(signature: string, payee: string | undefined, conn: ReceiptConn, usdtZar: number | null): Promise<ReceiptFacts> {
  const k = `${signature}:${payee ?? ""}`;
  const hit = factsCache.get(k);
  if (hit) return { ...hit, usdtZar };
  const facts = await chainReceiptFacts(signature, payee, conn, usdtZar);
  if (factsCache.size >= 1_000) factsCache.delete(factsCache.keys().next().value as string);
  factsCache.set(k, facts);
  return facts;
}
