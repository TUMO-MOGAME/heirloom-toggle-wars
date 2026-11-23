/**
 * "Check my letter": the deterministic review (plan.md §16.6). It runs first in both modes and is the floor the AI
 * cannot lower. It warns, it never blocks saving:
 *  - secrets: passwords, PINs and OTPs, a recovery (seed) phrase, a bank card number (Luhn), an account number, a
 *    South African ID number (date + Luhn);
 *  - the will: the letter gives an asset to the recipient that the plan does not ("Lerato, the Corolla is yours"
 *    while the plan sells it into the family vault), or a gift letter names an amount far from the rule's payment.
 * The letter text is only read here; nothing is stored or logged. The BIP-39 word list loads only when a letter has
 * a long run of short lowercase words (`reviewDraft`).
 */
import type { Base58 } from "../types";
import { amountsInText } from "../amount";
import type { LetterWarning, LetterWarningCode } from "./types";

export interface ReviewAsset {
  address: Base58;
  title: string;
  /** Where the plan sends it: the estate (sold, money into the family vault) or a person's wallet. */
  proceedsTo: Base58;
  kind?: string;
}
export interface ReviewCtx {
  /** The estate's address: proceeds to it mean "sold into the family vault". */
  estate: Base58;
  /** The letter's recipient wallet, or "family". */
  recipient: Base58 | "family";
  /** The recipient's short name ("Lerato"), or "family". */
  recipientName: string;
  assets: ReviewAsset[];
  /** The letter's "about" asset. */
  about?: Base58;
  /** A payment-linked letter's rule payment, in USD₮. */
  giftUsdt?: number;
  /** Rand per USD₮, to read "R 9 000". */
  usdtZar: number;
}

const SENTENCES = /[^.!?\n]+[.!?]?/g;
const GIFT = /\b(?:is|are)\s+(?:all\s+)?yours\b|\byours\s+now\b|\bis\s+for\s+you\b|\bi\s+(?:leave|give)\s+(?:it\s+(?:to\s+)?)?you\b|\bbelongs\s+to\s+you\b|\bjy\s+kry\b|\bis\s+joune\b|\bke\s+ya\s+hao\b|\bke\s+ya\s+gago\b|\bngeyakho\b|\bkungokwakho\b|\bngokwakho\b/i;
const KIND_WORDS: Record<string, string[]> = {
  Car: ["car", "bakkie", "motor", "kar", "imoto", "koloi"],
  Motorbike: ["motorbike", "bike", "motorfiets", "isithuthuthu"],
};
const STOP = new Set(["exclusive", "prestige", "automatic", "manual", "edition", "series", "model"]);

/** Words in an asset's title the owner might use for it ("Corolla", "Toyota", "Mustang"). */
export function assetWords(a: ReviewAsset): string[] {
  const words = a.title.split(/[^A-Za-zÀ-ÿ]+/).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()));
  const kind = a.kind ?? (/corolla|toyota|vw|polo|bakkie|sedan|hatch/i.test(a.title) ? "Car" : /bike|mustang|honda cb|yamaha/i.test(a.title) ? "Motorbike" : "");
  return [...words, ...(KIND_WORDS[kind] ?? [])];
}

const has = (s: string, word: string) => new RegExp(`(?:^|[^A-Za-zÀ-ÿ])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-zÀ-ÿ])`, "i").test(s);
const short = (s: string) => (s.length > 120 ? `${s.slice(0, 117).trimEnd()}…` : s).trim();

/* ---------- secrets ---------- */

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** A valid South African ID number: YYMMDD that is a real date, then Luhn over all 13 digits. */
export function isSaId(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  const mm = Number(digits.slice(2, 4)), dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const yy = Number(digits.slice(0, 2));
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  if (d.getUTCMonth() !== mm - 1) return false;
  if (!"012".includes(digits[10])) return false;
  return luhn(digits);
}

const PIN = /\b(?:pin|pin-?kode|pincode|otp|passcode)\b[^.\n\d]{0,30}?\b\d{4,6}\b/i;
const PASSWORD = /\b(?:password|passwords|wagwoord|phasewete|iphasiwedi|i-?password)\b[^.\n]{0,25}?(?:\bis\b|\bis:|:|=|\bke\b|\byi\b|\bngu)\s*["'“]?[^\s"'”]{4,}/i;
const SEED_WORDS = /\b(?:seed|recovery|secret|backup)\s+(?:phrase|words)\b|\bherstel-?frase\b|\bsaadfrase\b|\bgeheime\s+woorde\b/i;
const ACCOUNT = /\b(?:account|acc\.?\s*no|rekening|rekeningnommer|akhawunti|ak'?haonte|akhaonto)\b[^.\n\d]{0,30}?\b\d{6,11}\b/i;
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;
/** A run of 12+ short lowercase words: maybe a recovery phrase (checked against the BIP-39 list). */
const WORD_RUN = /(?:\b[a-z]{3,8}\b[ ,\n]+){11,}\b[a-z]{3,8}\b/;

export function needsSeedList(text: string): boolean {
  return WORD_RUN.test(text);
}

function seedRun(text: string, words: Set<string>): boolean {
  for (const m of text.matchAll(new RegExp(WORD_RUN.source, "g"))) {
    let run = 0;
    for (const w of m[0].split(/[ ,\n]+/)) {
      run = words.has(w) ? run + 1 : 0;
      if (run >= 12) return true;
    }
  }
  return false;
}

/* ---------- amounts ---------- */

function amountsIn(text: string, usdtZar: number): number[] {
  // One strict reading (lib/amount.ts): "R9,50" is nine rand fifty; an amount that could mean two things is left out.
  return amountsInText(text).flatMap((a) => {
    if (a.value === null || a.value <= 0 || !a.unit) return [];
    return [a.unit === "zar" ? Math.round((a.value / usdtZar) * 100) / 100 : a.value];
  });
}

/* ---------- the review ---------- */

/** Deterministic warnings, one per code at most. `words` is the BIP-39 list when it was loaded. */
export function reviewRules(text: string, ctx: ReviewCtx, words?: Set<string>): LetterWarning[] {
  const out: LetterWarning[] = [];
  const add = (w: LetterWarning) => { if (!out.some((x) => x.code === w.code)) out.push(w); };

  if (PIN.test(text)) add({ code: "secret.pin" });
  if (PASSWORD.test(text)) add({ code: "secret.password" });
  if (SEED_WORDS.test(text) || (words && seedRun(text, words))) add({ code: "secret.seed" });
  for (const m of text.matchAll(DIGIT_RUN)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length === 13 && isSaId(d)) add({ code: "secret.idNumber" });
    else if (d.length >= 15 && d.length <= 19 && luhn(d)) add({ code: "secret.card" });
  }
  if (ACCOUNT.test(text)) add({ code: "secret.account" });

  // An asset given in the letter that the plan does not give to this recipient.
  for (const sentence of text.match(SENTENCES) ?? []) {
    if (!GIFT.test(sentence)) continue;
    const named = ctx.assets.map((a) => ({ a, word: assetWords(a).find((w) => has(sentence, w)) }))
      .find((x) => x.word) ?? (ctx.about && /\b(it|this|that)\b/i.test(sentence) ? { a: ctx.assets.find((x) => x.address === ctx.about), word: undefined } : null);
    if (!named?.a) continue;
    const a = named.a;
    if (ctx.recipient !== "family" && a.proceedsTo === ctx.recipient) continue;
    // The word the letter used ("Corolla", "motorbike"), else the longest word of the title.
    const asset = named.word ?? [...assetWords(a)].sort((x, y) => y.length - x.length)[0] ?? a.title;
    const name = ctx.recipientName;
    add(a.proceedsTo === ctx.estate
      ? { code: "will.asset", quote: short(sentence), vars: { asset, name } }
      : { code: "will.other", quote: short(sentence), vars: { asset, name } });
  }

  // A gift letter that names a different amount from the rule's payment.
  if (ctx.giftUsdt) {
    const named = amountsIn(text, ctx.usdtZar);
    if (named.length && !named.some((n) => Math.abs(n - ctx.giftUsdt!) <= ctx.giftUsdt! * 0.05)) {
      add({ code: "will.amount", vars: { amount: `${named[0].toLocaleString("en-ZA")} USD₮`, gift: `${ctx.giftUsdt.toLocaleString("en-ZA")} USD₮` } });
    }
  }
  return out;
}

/** reviewRules, loading the BIP-39 list first when the text has a long run of short words. */
export async function reviewDraft(text: string, ctx: ReviewCtx): Promise<LetterWarning[]> {
  const words = needsSeedList(text) ? (await import("./bip39-english")).BIP39_ENGLISH : undefined;
  return reviewRules(text, ctx, words);
}

const CODES = new Set<LetterWarningCode>(["secret.password", "secret.pin", "secret.seed", "secret.card", "secret.account", "secret.idNumber", "will.asset", "will.amount", "will.other"]);

/** The AI's extra warnings after the rules' own: never drops a rule warning, one per code, at most 6 from the AI. */
export function mergeReview(rules: LetterWarning[], ai: { code: string; quote?: string; note?: string }[]): LetterWarning[] {
  const out = [...rules];
  for (const w of ai.slice(0, 6)) {
    if (!CODES.has(w.code as LetterWarningCode) || out.some((x) => x.code === w.code)) continue;
    out.push({ code: w.code as LetterWarningCode, ...(w.quote ? { quote: short(w.quote) } : {}), ...(w.note ? { note: w.note.slice(0, 200) } : {}) });
  }
  return out;
}
