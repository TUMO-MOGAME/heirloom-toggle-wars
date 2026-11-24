import { z } from "zod";
import { dailyCap, handler, HttpError, isChainMode, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { getConnection } from "@/lib/chain/tx";
import { getUsdtZar } from "@/lib/fx";
import { hasElevenLabs } from "@/lib/legacy/server/elevenlabs";
import { heirloomVoice } from "@/lib/legacy/server/standin";
import { DEMO_FX } from "@/lib/service/mock-valuation";
import { VOICE_LANGUAGE_CODES, type VoiceLanguage } from "@/lib/voice/languages";
import { DEMO_RECEIPT_ID, parseDemoReceiptId, receiptWords, type ReceiptFacts } from "@/lib/voice/receipts";
import {
  cacheReceiptAudio, cachedReceiptAudio, chainReceiptFactsCached, receiptCacheKey, ReceiptError, speakReceipt,
} from "@/lib/voice/server/receipt";

export const maxDuration = 30;

const lang = z.enum(VOICE_LANGUAGE_CODES as [VoiceLanguage, ...VoiceLanguage[]]);
const base58 = (min: number, max: number) => z.string().min(min).max(max).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
/** Devnet: a transaction signature, and which wallet it paid when it paid more than one. Nothing else. */
const ChainBody = z.object({ signature: base58(64, 88), payee: base58(32, 44).optional(), lang }).strict();
/** Demo: a receipt id made only of keys into the demo's fixed data, an amount and a time. Nothing else. */
const DemoBody = z.object({ receiptId: z.string().max(80).regex(DEMO_RECEIPT_ID), lang }).strict();

/**
 * POST /api/voice/receipt → { text, lang, spoken, translated, audio (base64 MP3) | null } (plan §20.1 item 3).
 * A spoken receipt for one payment the program made: devnet { signature, payee?, lang }, the demo { receiptId, lang }.
 * The words are built on the server from the payment's own facts (lib/voice/server/receipt.ts), never from text in
 * the request, so this is not a free text-to-speech service. Limits: 20 a minute per IP, then the "receipt" daily cap
 * for each new rendering (repeats are served from the cache). Without ELEVENLABS_API_KEY: 503 with the words, which
 * the screen shows instead (the browser's own voice is never used). Languages ElevenLabs can't speak get the words only.
 */
export const POST = handler(async (req) => {
  const chain = isChainMode();
  const body = chain ? await parseJson(req, ChainBody, 2_000) : await parseJson(req, DemoBody, 2_000);
  await rateLimitShared(req, "voice-receipt", 20);

  let facts: ReceiptFacts | null;
  if ("signature" in body) {
    const fx = await getUsdtZar();
    const rate = fx.source.startsWith("fallback") ? null : fx.usdtZar;
    facts = await chainReceiptFactsCached(body.signature, body.payee, getConnection(), rate).catch((e: unknown) => {
      if (e instanceof ReceiptError) throw new HttpError(e.status, e.message, e.code);
      console.error("[receipt] devnet read failed:", e instanceof Error ? e.message.replace(/(https?|wss?):\/\/\S+/g, "[url]") : e);
      throw new HttpError(502, "Devnet could not be read just now. Please try again.", "rpc");
    });
  } else {
    facts = parseDemoReceiptId(body.receiptId, DEMO_FX);
  }
  if (!facts) throw new HttpError(404, "That is not one of the demo's payments.", "not_receipt");

  const words = receiptWords(facts, body.lang);
  const out = { text: words.text, lang: words.lang, spoken: words.spoken, translated: words.translated };
  if (!words.spoken) return json({ ...out, audio: null });
  const unavailable = () => json({ error: "The voice is not available right now.", code: "unavailable", ...out, spoken: false }, { status: 503 });
  if (!hasElevenLabs()) return unavailable();

  const voice = heirloomVoice();
  const key = receiptCacheKey(words, voice);
  let audio = cachedReceiptAudio(key);
  if (!audio) {
    await dailyCap(req, "receipt");
    try {
      audio = await speakReceipt(words, voice);
    } catch (e) {
      console.error("[receipt] voice failed:", e instanceof Error ? e.message : e);
      return unavailable();
    }
    cacheReceiptAudio(key, audio);
  }
  return json({ ...out, audio: Buffer.from(audio).toString("base64") });
});
