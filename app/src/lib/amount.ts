/**
 * One strict reading of a typed amount, used everywhere an amount is typed or read from text (plan §18.9 H1).
 * South Africans write "9,50" and "1 234,50"; others write "1,234.50". Both are read, and anything that could mean
 * two different amounts is refused (null) rather than guessed: "1.000" may be one or a thousand.
 *
 * Accepted: 9,50 · 9.50 · 1 234,50 · 1,234.50 · 1,000 · 12.345,60 · 0,005 · up to 6 decimals.
 * Refused: 1.000 / 1.234 (dot and three digits), 12,34,567, 1,2345.6, mixed grouping, more than 6 decimals, signs.
 * Pure.
 */

export const AMOUNT_DECIMALS = 6;
/** Spaces people (and phones) put between thousands. */
const SPACE = /[    ]/g;
const HAS_SPACE = /[    ]/;

/** The number written in `text` (digits and separators only, no currency), or null when it is not one amount. */
export function parseAmount(text: string): number | null {
  const raw = text.trim();
  if (!raw || raw.length > 32) return null;
  // Space grouping: "1 234" or "1 234,50" / "1 234.50".
  if (HAS_SPACE.test(raw)) {
    const m = raw.match(/^(\d{1,3}(?:[    ]\d{3})+)(?:[.,](\d{1,6}))?$/);
    if (!m) return null;
    return finish(m[1].replace(SPACE, ""), m[2]);
  }
  if (/^\d+$/.test(raw)) return finish(raw);
  const seps = raw.replace(/\d/g, "");
  if (!/^[.,]+$/.test(seps) || !/^\d/.test(raw) || !/\d$/.test(raw)) return null;
  const parts = raw.split(/[.,]/);
  if (parts.some((p) => p === "")) return null;
  const kinds = new Set(seps);
  if (kinds.size === 1) {
    const sep = seps[0];
    if (seps.length === 1) {
      const [int, frac] = parts;
      // "1,000" groups thousands; "1.000" could be 1 or 1 000, so it is refused.
      if (frac.length === 3 && int.length <= 3 && int !== "0") return sep === "," ? finish(int + frac) : null;
      return frac.length <= AMOUNT_DECIMALS ? finish(int, frac) : null;
    }
    // Several of the same: thousands only ("1,000,000", "1.000.000").
    return grouped(parts) ? finish(parts.join("")) : null;
  }
  // Both: the last one is the decimal mark, the other groups thousands.
  const dec = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
  const group = dec === "." ? "," : ".";
  const [whole, frac] = [raw.slice(0, raw.lastIndexOf(dec)), raw.slice(raw.lastIndexOf(dec) + 1)];
  if (whole.includes(dec) || !/^\d{1,6}$/.test(frac)) return null;
  const groups = whole.split(group);
  return grouped(groups) ? finish(groups.join(""), frac) : null;
}

function grouped(parts: string[]): boolean {
  return parts.length > 1 && /^\d{1,3}$/.test(parts[0]) && parts[0] !== "0" && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

function finish(int: string, frac = ""): number | null {
  if (int.length > 15) return null;
  const n = Number(frac ? `${int}.${frac}` : int);
  return Number.isFinite(n) ? n : null;
}

/** A number as text the parser reads back exactly: never three decimals after a dot ("12.345" would be refused). */
export function amountText(n: number): string {
  if (!Number.isFinite(n)) return "";
  const s = String(Math.round(n * 10 ** AMOUNT_DECIMALS) / 10 ** AMOUNT_DECIMALS);
  const [int, frac] = s.split(".");
  if (!frac) return int;
  return `${int}.${frac.length === 1 || frac.length === 3 ? `${frac}0` : frac}`;
}

export type AmountUnit = "zar" | "usd";
export interface FoundAmount { value: number | null; unit: AmountUnit | null; index: number }

const TOKEN = /\d+(?:[.,]+\d+|[    ]\d{3}(?!\d))*/g;
const ZAR_BEFORE = /(?:^|[^\p{L}\p{N}])(?:R|ZAR)\s?$/iu;
const USD_BEFORE = /(?:\$\s?|(?:^|[^\p{L}\p{N}])(?:usdt|usd₮|usd)\s?)$/iu;
const ZAR_AFTER = /^\s?(?:zar|rands?)(?![\p{L}])/iu;
const USD_AFTER = /^\s?(?:usdt|usd₮|usd|dollars?|tether)(?![\p{L}₮])/iu;

/**
 * Every amount written in free text, in order, with its currency when one is written next to it. A number that is
 * not one clear amount has value null, so callers refuse it instead of reading part of it. "2k" is 2 000.
 */
export function amountsInText(text: string): FoundAmount[] {
  const out: FoundAmount[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    const token = m[0];
    const before = text.slice(0, index);
    let after = text.slice(index + token.length);
    const k = /^\s?k\b/i.exec(after);
    if (k) after = after.slice(k[0].length);
    const unit: AmountUnit | null = ZAR_BEFORE.test(before) || ZAR_AFTER.test(after) ? "zar"
      : USD_BEFORE.test(before) || USD_AFTER.test(after) ? "usd" : null;
    // A bare number stands on its own (not inside a word, a date or a negative).
    if (!unit && !(before === "" || /\s$/.test(before))) continue;
    if (!unit && !(after === "" || /^[\s.,!?;:)]/.test(after))) continue;
    const n = parseAmount(token);
    const value = n === null ? null : k ? Math.round(n * 1000 * 1e6) / 1e6 : n;
    out.push({ value, unit, index });
  }
  return out;
}

/**
 * The hint under an amount field (N9): how to write one while it is empty (or `ok` has nothing to say), the unclear-amount words when what was
 * typed could be read two ways (never a conversion of a guess), else `ok`, the field's own hint for the amount read.
 */
export function amountHint(text: string, ok: (n: number) => string | undefined, words: { unclear: string; format: string }): string {
  if (!text.trim()) return words.format;
  const n = parseAmount(text);
  return n === null ? words.unclear : ok(n) ?? words.format;
}
