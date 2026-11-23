/**
 * The canonical form of a letter, its hash and the signed message (plan.md §16.3). Shared by the browser (the chain
 * service signs with the owner's wallet), the server route (verifies) and the mock (hashes its letters the same way).
 *
 * - `canonicalLetter` is JSON with keys in a fixed order (id, estate, from, to, opens, occasion, text, about,
 *   transcribed, version); absent optionals are left out. The text and occasion are cleaned first, so both sides
 *   hash exactly what is stored.
 * - The signed message binds the action, estate, wallet, time and a SHA-256 of the body, like the tree's routes.
 */
import type { Base58 } from "../types";
import { sha256Hex } from "../agent/hash";
import type { LetterInput, LetterOpens, LetterTo } from "./types";

/** Newlines as \n, no control characters except \n, at most two blank lines in a row, trimmed. */
export function cleanLetterText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** One line, single spaces, trimmed. */
export function cleanOccasion(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

const toOf = (t: LetterTo) => (t.kind === "family" ? { kind: "family" } : { kind: "person", wallet: t.wallet });
const opensOf = (o: LetterOpens) =>
  o.kind === "unlock" ? { kind: "unlock" }
    : o.kind === "date" ? { kind: "date", on: o.on }
      : o.kind === "payment" ? { kind: "payment", rule: o.rule }
        : { kind: "send", signature: o.signature };

/** The cleaned input, as it is stored and hashed. */
export function cleanInput(input: LetterInput): LetterInput {
  return {
    id: input.id, to: input.to, opens: input.opens,
    occasion: cleanOccasion(input.occasion), text: cleanLetterText(input.text),
    ...(input.about ? { about: { asset: input.about.asset } } : {}),
    ...(input.transcribed ? { transcribed: { person: input.transcribed.person, year: input.transcribed.year } } : {}),
  };
}

export function canonicalLetter(estate: Base58, from: Base58, input: LetterInput, version: number): string {
  const c = cleanInput(input);
  const out: Record<string, unknown> = { id: c.id, estate, from, to: toOf(c.to), opens: opensOf(c.opens), occasion: c.occasion, text: c.text };
  if (c.about) out.about = { asset: c.about.asset };
  if (c.transcribed) out.transcribed = { person: c.transcribed.person, year: c.transcribed.year };
  out.version = version;
  return JSON.stringify(out);
}

export const letterHash = (estate: Base58, from: Base58, input: LetterInput, version: number) => sha256Hex(canonicalLetter(estate, from, input, version));

export type LetterAction = "write" | "delete" | "list" | "review" | "suggest";
export const LETTER_MAX_SKEW_MS = 5 * 60 * 1000;

export function letterMessage(action: LetterAction, estate: Base58, wallet: Base58, ts: number, bodyHex: string): string {
  return `Heirloom letter\naction:${action}\nestate:${estate}\nwallet:${wallet}\nts:${ts}\nbody:${bodyHex}`;
}

/** The signed body of a delete. */
export const deleteBody = (id: string, version: number) => JSON.stringify({ id, version });
/** The signed body of a list. */
export const LIST_BODY = "{}";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A new letter id, made in the browser. */
export function newLetterId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return `ltr_${Array.from(random(16), (b) => B58[b % 58]).join("")}`;
}
