/**
 * Chip in (plan §21): anyone, from any Solana wallet, adds USD₮ to a family's vault by scanning a QR code or opening
 * a link. No Heirloom account. Pure and browser-safe (no web3.js), so the demo bundle stays small.
 *
 * Standards used:
 * - Solana Pay *transaction request* (`solana:<https link>`): the wallet GETs {label, icon}, POSTs {account} and gets
 *   back an unsigned transaction. A transfer request (`solana:<recipient>?spl-token=`) is not used: the vault's owner
 *   is the estate PDA (off-curve), and wallets derive the token account with allowOwnerOffCurve=false.
 * - Solana Actions (blinks): the same endpoint answers the Actions GET/POST shape, and /actions.json maps the public
 *   page /chip-in/<estate> to it.
 * - References: every chip-in carries two read-only, non-signer keys on its transfer instruction. The estate's tag
 *   (the same for every chip-in to one vault) lets the owner's app list them with getSignaturesForAddress; a fresh
 *   per-request reference lets one QR code be found on its own (Solana Pay findReference).
 */
import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha2";
import { parseAmount } from "../amount";
import { toBase } from "../format";

/** The largest single chip-in, in USD₮. A gift, not a treasury move. */
export const MAX_CHIP_IN_USDT = 10_000;
/** Preset amounts offered on the QR card and as blink buttons. */
export const CHIP_IN_PRESETS = [25, 50, 100] as const;
/** The one label a wallet shows: never a family's name. */
export const CHIP_IN_LABEL = "Heirloom vault";
/** Public paths: the page people open, and the API wallets call. */
export const chipInPagePath = (estate: string) => `/chip-in/${estate}`;
export const chipInApiPath = (estate: string) => `/api/chipin/${estate}`;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 string that decodes to exactly 32 bytes (the shape of every Solana address). */
export function isAddress(s: unknown): s is string {
  if (typeof s !== "string" || !BASE58.test(s)) return false;
  try { return bs58.decode(s).length === 32; } catch { return false; }
}

/**
 * The estate's chip-in tag: sha256("heirloom:chip-in:v1" ‖ estate) as an address. Nobody holds a key for it (it is
 * only ever a read-only account), and anyone can compute it from the estate, which is the point: the owner's app
 * finds every chip-in by it. A transaction that names the tag proves nothing by itself; each one is checked.
 */
export function chipInTag(estate: string): string {
  if (!isAddress(estate)) throw new Error("Not an estate address");
  const seed = new Uint8Array([...new TextEncoder().encode("heirloom:chip-in:v1"), ...bs58.decode(estate)]);
  return bs58.encode(sha256(seed));
}

/** A fresh per-request reference (32 random bytes), as Solana Pay asks for. */
export function newReference(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bs58.encode(bytes);
}

export type AmountCheck = { ok: true; base: bigint; usdt: number } | { ok: false; code: "amount_missing" | "amount_unclear" | "amount_zero" | "amount_too_big" };

/** The app's strict amount reading (lib/amount.ts), then the chip-in limits: above zero, at most MAX_CHIP_IN_USDT. */
export function checkChipInAmount(text: string | null | undefined): AmountCheck {
  if (text === null || text === undefined || !text.trim()) return { ok: false, code: "amount_missing" };
  const n = parseAmount(text);
  if (n === null) return { ok: false, code: "amount_unclear" };
  const base = toBase(n);
  if (base <= 0n) return { ok: false, code: "amount_zero" };
  if (base > toBase(MAX_CHIP_IN_USDT)) return { ok: false, code: "amount_too_big" };
  return { ok: true, base, usdt: n };
}

/** The endpoint wallets call for one amount (and optionally one reference). */
export function chipInApiUrl(origin: string, estate: string, q: { amount?: number | string; reference?: string } = {}): string {
  const url = new URL(chipInApiPath(estate), origin);
  if (q.amount !== undefined) url.searchParams.set("amount", String(q.amount));
  if (q.reference) url.searchParams.set("reference", q.reference);
  return url.toString();
}

/**
 * The Solana Pay transaction-request URL for an https link. The spec: a link with query parameters must be
 * URL-encoded; one without should not be (a shorter URL, a less dense QR code).
 */
export function solanaPayUrl(link: string): string {
  const u = new URL(link);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) {
    throw new Error("A Solana Pay link must be https");
  }
  return `solana:${u.search ? encodeURIComponent(link) : link}`;
}

/** The blink form of the same link (`solana-action:`), for clients that unfurl Actions. */
export const solanaActionUrl = (link: string) => `solana-action:${link}`;

/** The public page anyone can open: preset amounts, a QR code and an "Open in wallet" link. */
export const chipInPageUrl = (origin: string, estate: string) => new URL(chipInPagePath(estate), origin).toString();
