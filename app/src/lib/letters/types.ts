/**
 * Letters for later (plan.md §16): personal letters from the estate owner that open at the estate's unlock, on a
 * date, or with a USD₮ payment from the plan. Off-chain and signed by the owner's wallet; nothing goes on-chain.
 * Zod-free, so the UI, both services and the server share these types without pulling a schema library.
 */
import type { Base58 } from "../types";
import type { Locale } from "../i18n/locales";
import type { PersonId } from "../tree/types";

export type DemoLetterKey = "family" | "lerato" | "naledi" | "mkhulu";

/** At most this many characters of text, after cleaning (about 350 words). */
export const LETTER_MAX_CHARS = 2000;
/** "For your 18th birthday". */
export const OCCASION_MAX = 60;
/** Live (not deleted) letters per estate. */
export const LETTERS_PER_ESTATE = 50;
/** Request bytes for a letter write. */
export const LETTER_MAX_BODY = 16 * 1024;
/** A letter id: "ltr_" + 16 base58 characters, made in the browser. */
export const LETTER_ID = /^ltr_[1-9A-HJ-NP-Za-km-z]{16}$/;

export type LetterTo = { kind: "family" } | { kind: "person"; wallet: Base58 };
export type LetterOpens =
  | { kind: "unlock" }
  /** "YYYY-MM-DD", opens 00:00 South African time (UTC+2). */
  | { kind: "date"; on: string }
  /** The first payment under this rule after the letter was linked (its on-chain spent_total goes up). */
  | { kind: "payment"; rule: Base58 }
  /** A confirmed send-to-family transfer (plan.md §16.14 step 9). */
  | { kind: "send"; signature: string };
export type LetterOpensKind = LetterOpens["kind"];

/** What the owner writes and signs. */
export interface LetterInput {
  id: string;
  to: LetterTo;
  opens: LetterOpens;
  /** May be "". */
  occasion: string;
  text: string;
  /** "About: the Corolla" (shown, and used by the review). */
  about?: { asset: Base58 };
  /** A real letter by someone who has passed, typed out by the owner. */
  transcribed?: { person: PersonId; year: number };
}

export interface Letter extends LetterInput {
  estate: Base58;
  /** The author: the estate owner's wallet. */
  from: Base58;
  /** 1, 2, 3 ... (a write must send stored + 1). */
  version: number;
  /** sha256 hex of canonicalLetter(). */
  hash: string;
  /** The owner's signature of the write (hex); null = a seeded demo letter. */
  sig: string | null;
  /** Milliseconds: the signed ts. */
  signedAt: number;
  /** Unix seconds. */
  createdAt: number;
  updatedAt: number;
  /** payment: the rule's spent_total (base units, as a decimal string) when the link was made. Set by the server. */
  baseline?: string;
  /** Unix seconds, the first time the letter was seen open (sticky). */
  openedAt: number | null;
  /** A tombstone: text, occasion and about are emptied. */
  deleted?: true;
  /**
   * Seeded demo letters only (sig null): which story letter this is, so the UI shows it in the visitor's language
   * (content/letters.ts demo.*). "mkhulu" is Thabo's own words about his late father, labelled "Added by Thabo, 2026".
   */
  demoKey?: DemoLetterKey;
}

export type LetterState = "locked" | "open";
export interface LetterHint {
  /** Unix seconds: the expected opening (a date letter's day, a payment rule's next due). */
  on?: number;
  /** The linked rule's payment, in USD₮. */
  giftUsdt?: number;
  /** Who the rule is for and what it pays for, e.g. "Naledi · General". */
  ruleLabel?: string;
  /** The payment that opened it (tx signature) and when (unix seconds), when known. */
  paidSig?: string;
  paidAt?: number;
}
export interface LetterView extends Letter {
  state: LetterState;
  /** What the UI says about the opening. */
  hint: LetterHint;
}
/** An opened letter for the Trust Tree: who, to whom, the year it opened. Never an id or text. */
export interface LetterCount { from: Base58; to: Base58 | "family"; year: number; imagined?: true }
export interface LettersView {
  letters: LetterView[];
  counts: LetterCount[];
  /** Unlocked or Frozen: nothing can change. */
  sealed: boolean;
  /** DeathPending: writes pause while a passing is confirmed. */
  paused: boolean;
}

export type LetterWarningCode =
  | "secret.password" | "secret.pin" | "secret.seed" | "secret.card" | "secret.account" | "secret.idNumber"
  | "will.asset" | "will.amount" | "will.other";
export const LETTER_WARNING_CODES: readonly LetterWarningCode[] = [
  "secret.password", "secret.pin", "secret.seed", "secret.card", "secret.account", "secret.idNumber", "will.asset", "will.amount", "will.other",
];
export interface LetterWarning { code: LetterWarningCode; quote?: string; vars?: Record<string, string>; note?: string }
export interface LetterReview { warnings: LetterWarning[]; source: "rules" | "rules+ai" }

export interface LetterSuggestInput { to: LetterTo; occasion: string; points: string }
export interface LetterSuggestion { text: string; source: "template" | "ai" }

export interface LettersService {
  /** Owner: all their letters. Beneficiary: open letters they may read. Both: counts for the tree. Others: refused. */
  /**
   * `quiet`: a background read (a card, a notice, the tree's count) that must never ask for a PIN. If signing would
   * need the wallet to be unlocked first, it answers from this device only, like when the server is unreachable.
   */
  listLetters(estate: Base58, opts?: { quiet?: boolean }): Promise<LettersView>;
  /** Owner, Active only. `version` = stored + 1 (1 for a new letter). */
  saveLetter(estate: Base58, input: LetterInput, version: number): Promise<LetterView>;
  /** Owner, Active only (open letters too). Keeps a tombstone with the next version. */
  deleteLetter(estate: Base58, id: string, version: number): Promise<void>;
  /** Owner: warnings for a draft (never saved, never logged). */
  reviewLetter(estate: Base58, draft: LetterInput, locale: Locale): Promise<LetterReview>;
  /** Owner: a suggested draft for the owner to change into their own words. */
  suggestLetter(estate: Base58, input: LetterSuggestInput, locale: Locale): Promise<LetterSuggestion>;
  /** Opened letters by person and year, for the Trust Tree card (the demo adds imagined future ones). */
  letterCounts(estate: Base58): Promise<LetterCount[]>;
}
