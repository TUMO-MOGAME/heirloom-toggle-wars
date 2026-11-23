/**
 * The rules of Letters for later (plan.md §16.4): when a letter opens, who may read it, who may write it and what a
 * letter may say about its opening. Pure functions, used by the mock, the chain service, the server route and the UI
 * (like lib/tree/photos.ts photoConsent), so every side applies the same rules.
 */
import type { Base58, EstateStatus } from "../types";
import { cleanLetterText, cleanOccasion } from "./canonical";
import { LETTER_ID, LETTER_MAX_CHARS, LETTERS_PER_ESTATE, OCCASION_MAX, type Letter, type LetterCount, type LetterInput, type LetterState } from "./types";

const HOUR = 3_600_000;
/** South African Standard Time is UTC+2 all year. */
export const SAST_OFFSET_MS = 2 * HOUR;
/** Date letters must open before this year. */
export const LAST_YEAR = 2127;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds of 00:00 SAST on a "YYYY-MM-DD" day, or NaN for a date that does not exist. */
export function opensAt(on: string): number {
  const m = DATE.exec(on);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN;
  return utc - SAST_OFFSET_MS;
}

/** Today's date in South Africa, "YYYY-MM-DD". */
export const sastDay = (nowMs: number) => new Date(nowMs + SAST_OFFSET_MS).toISOString().slice(0, 10);
/** The year in South Africa. */
export const sastYear = (nowMs: number) => new Date(nowMs + SAST_OFFSET_MS).getUTCFullYear();

export interface OpenCtx {
  status: EstateStatus;
  nowMs: number;
  /** The rule's live spent_total, or null when it could not be read (then the letter stays locked). */
  ruleSpent(rule: Base58): bigint | null;
  /** Which rule holds the slot now (its claim ids' high 16 bits): a slot reused by a new rule is another rule. */
  ruleGeneration?(rule: Base58): number;
  /** True when the send-to-family transfer is confirmed. */
  sendConfirmed(signature: string): boolean;
}

/**
 * A payment link's baseline: the rule's spent_total when linked, with the slot's rule generation above 64 bits. A
 * first rule (generation 0) gives the plain spent_total, as before; numeric, so it stores as it always did.
 */
export function linkBaseline(rule: { spentTotal: bigint; claimCount?: number } | undefined): string {
  const generation = BigInt(((rule?.claimCount ?? 0) >>> 16));
  return ((generation << 64n) + (rule?.spentTotal ?? 0n)).toString();
}

export function readBaseline(baseline: string): { generation: number; spent: bigint } {
  const b = BigInt(baseline);
  return { generation: Number(b >> 64n), spent: b & ((1n << 64n) - 1n) };
}

/** Open or locked. Once seen open it stays open (openedAt is sticky); a deleted letter is locked. */
export function letterState(l: Pick<Letter, "opens" | "openedAt" | "deleted" | "baseline">, ctx: OpenCtx): LetterState {
  if (l.deleted) return "locked";
  if (l.openedAt !== null && l.openedAt !== undefined) return "open";
  const o = l.opens;
  switch (o.kind) {
    case "unlock": return ctx.status === "Unlocked" ? "open" : "locked";
    case "date": { const t = opensAt(o.on); return Number.isFinite(t) && ctx.nowMs >= t ? "open" : "locked"; }
    case "payment": {
      if (l.baseline === undefined) return "locked";
      const spent = ctx.ruleSpent(o.rule);
      try {
        const { generation, spent: base } = readBaseline(l.baseline);
        // A gift linked to a rule whose place a new rule took never opens with the new rule's payments.
        if (generation !== (ctx.ruleGeneration?.(o.rule) ?? 0)) return "locked";
        return spent !== null && spent > base ? "open" : "locked";
      } catch { return "locked"; }
    }
    case "send": return ctx.sendConfirmed(o.signature) ? "open" : "locked";
  }
}

export interface ReadCtx extends OpenCtx {
  /** Wallets of the estate's active beneficiaries. */
  activeBeneficiaries: Base58[];
}

/** The author always; otherwise only once open: the named person, or (a family letter) an active beneficiary. */
export function canRead(l: Letter, viewer: Base58 | null, ctx: ReadCtx): boolean {
  if (!viewer) return false;
  if (viewer === l.from) return true;
  if (l.deleted || letterState(l, ctx) !== "open") return false;
  if (l.to.kind === "person") return viewer === l.to.wallet && ctx.activeBeneficiaries.includes(viewer);
  return ctx.activeBeneficiaries.includes(viewer);
}

export type WriteRefusal = "forbidden" | "paused" | "sealed" | "opened" | "version" | "full";
export interface WriteCtx {
  actor: Base58 | null;
  owner: Base58;
  status: EstateStatus;
  /** The stored letter with this id, if any (a tombstone included). */
  existing: Letter | null;
  /** Is the stored letter open now? */
  existingOpen: boolean;
  /** The version the write sends. */
  version: number;
  /** Live (not deleted) letters in the estate. */
  liveCount: number;
  action: "write" | "delete";
}

/** Why a write or delete is refused, or null. An open letter may be deleted but no longer edited. */
export function canWrite(ctx: WriteCtx): WriteRefusal | null {
  if (!ctx.actor || ctx.actor !== ctx.owner) return "forbidden";
  if (ctx.status === "DeathPending") return "paused";
  if (ctx.status !== "Active") return "sealed";
  const live = ctx.existing && !ctx.existing.deleted ? ctx.existing : null;
  if (ctx.action === "write" && live && ctx.existingOpen) return "opened";
  if (ctx.version !== (ctx.existing?.version ?? 0) + 1) return "version";
  if (ctx.action === "delete" && !live) return "version";
  if (ctx.action === "write" && !live && ctx.liveCount >= LETTERS_PER_ESTATE) return "full";
  return null;
}

export type LetterProblem = "id" | "empty" | "tooLong" | "occasion" | "recipient" | "date" | "link" | "about" | "transcribed";
export interface CheckCtx {
  nowMs: number;
  activeBeneficiaries: Base58[];
  rules: { address: Base58; beneficiary: Base58 }[];
  assets: Base58[];
  /** True for someone who has passed or has no wallet (a transcribed letter's writer). */
  canTranscribe(person: string): boolean;
}

/** What is wrong with a letter, or null. `field` names the input that needs fixing. */
export function checkLetter(input: LetterInput, ctx: CheckCtx): { code: LetterProblem; field: keyof LetterInput } | null {
  if (!LETTER_ID.test(input.id)) return { code: "id", field: "id" };
  const text = cleanLetterText(input.text);
  if (!text) return { code: "empty", field: "text" };
  if ([...text].length > LETTER_MAX_CHARS) return { code: "tooLong", field: "text" };
  if ([...cleanOccasion(input.occasion)].length > OCCASION_MAX) return { code: "occasion", field: "occasion" };
  if (input.to.kind === "person" && !ctx.activeBeneficiaries.includes(input.to.wallet)) return { code: "recipient", field: "to" };
  const o = input.opens;
  if (o.kind === "date") {
    const t = opensAt(o.on);
    if (!Number.isFinite(t) || o.on <= sastDay(ctx.nowMs) || Number(o.on.slice(0, 4)) >= LAST_YEAR) return { code: "date", field: "opens" };
  }
  if ((o.kind === "payment" || o.kind === "send") && input.to.kind !== "person") return { code: "link", field: "opens" };
  if (o.kind === "payment") {
    const r = ctx.rules.find((x) => x.address === o.rule);
    if (!r || input.to.kind !== "person" || r.beneficiary !== input.to.wallet) return { code: "link", field: "opens" };
  }
  if (o.kind === "send" && !/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(o.signature)) return { code: "link", field: "opens" };
  if (input.about && !ctx.assets.includes(input.about.asset)) return { code: "about", field: "about" };
  if (input.transcribed) {
    const t = input.transcribed;
    if (!ctx.canTranscribe(t.person) || !Number.isInteger(t.year) || t.year > sastYear(ctx.nowMs) || t.year < 1850) return { code: "transcribed", field: "transcribed" };
  }
  return null;
}

/** Opened, non-deleted letters as counts for the Trust Tree: no ids, no text. */
export function visibleCounts(letters: Letter[], ctx: OpenCtx): LetterCount[] {
  const out: LetterCount[] = [];
  for (const l of letters) {
    if (l.deleted || letterState(l, ctx) !== "open") continue;
    const at = l.openedAt ?? Math.floor(ctx.nowMs / 1000);
    out.push({ from: l.from, to: l.to.kind === "family" ? "family" : l.to.wallet, year: sastYear(at * 1000) });
  }
  return out;
}

/** Live (not deleted) letters. */
export const liveLetters = <T extends Pick<Letter, "deleted">>(ls: T[]) => ls.filter((l) => !l.deleted);
