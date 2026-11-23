import "server-only";
/**
 * Letters for later in Supabase (supabase/migrations/0008_family_letters.sql), or in memory when Supabase is not
 * configured (then they last as long as the server instance; the owner's browser keeps its own copy of their letters,
 * lib/service/chain-letters.ts). Personal information: never on-chain, never logged.
 *
 * - `putLetter` writes only when the version is the stored one + 1 (an update `where version = prev`, an insert for
 *   1), so two saves of the same letter cannot both win, and an old signed write cannot be replayed.
 * - A delete is a tombstone: text, occasion and about are emptied at once.
 */
import { getSupabase } from "@/lib/supabase";
import type { Base58 } from "@/lib/types";
import type { Letter, LetterOpens, LetterTo } from "../types";
import { StoreFull } from "@/lib/server/memory-limits";

/** Per instance without Supabase: letters per estate (live + tombstones) and estates kept. */
export const MAX_PER_ESTATE = 120;
export const MAX_ESTATES = 2_000;
const mem = new Map<Base58, Map<string, Letter>>();

interface Row {
  estate: string; id: string; author: string; recipient: string;
  opens_kind: LetterOpens["kind"]; opens_on: string | null; opens_rule: string | null; baseline: string | null; opens_sig: string | null;
  about_asset: string | null; transcribed: { person: string; year: number } | null;
  occasion: string; body: string; version: number; hash: string; sig: string | null;
  signed_at: number; created_at: number; updated_at: number; opened_at: number | null; deleted: boolean;
}

function toRow(l: Letter): Row {
  const o = l.opens;
  return {
    estate: l.estate, id: l.id, author: l.from, recipient: l.to.kind === "family" ? "family" : l.to.wallet,
    opens_kind: o.kind, opens_on: o.kind === "date" ? o.on : null, opens_rule: o.kind === "payment" ? o.rule : null,
    baseline: l.baseline ?? null, opens_sig: o.kind === "send" ? o.signature : null,
    about_asset: l.about?.asset ?? null, transcribed: l.transcribed ?? null,
    occasion: l.occasion, body: l.text, version: l.version, hash: l.hash, sig: l.sig,
    signed_at: l.signedAt, created_at: l.createdAt, updated_at: l.updatedAt, opened_at: l.openedAt, deleted: !!l.deleted,
  };
}

export function fromRow(r: Row): Letter {
  const to: LetterTo = r.recipient === "family" ? { kind: "family" } : { kind: "person", wallet: r.recipient };
  const opens: LetterOpens = r.opens_kind === "date" ? { kind: "date", on: String(r.opens_on).slice(0, 10) }
    : r.opens_kind === "payment" ? { kind: "payment", rule: String(r.opens_rule) }
      : r.opens_kind === "send" ? { kind: "send", signature: String(r.opens_sig) } : { kind: "unlock" };
  return {
    id: r.id, estate: r.estate, from: r.author, to, opens, occasion: r.occasion, text: r.body,
    ...(r.about_asset ? { about: { asset: r.about_asset } } : {}),
    ...(r.transcribed ? { transcribed: r.transcribed } : {}),
    version: r.version, hash: r.hash, sig: r.sig, signedAt: Number(r.signed_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    ...(r.baseline !== null && r.baseline !== undefined ? { baseline: String(r.baseline) } : {}),
    openedAt: r.opened_at === null || r.opened_at === undefined ? null : Number(r.opened_at),
    ...(r.deleted ? { deleted: true as const } : {}),
  };
}

function warn(what: string, err: { message: string } | null) {
  if (err) console.warn(`[family_letters] ${what} failed: ${err.message}`);
}

export async function getLetters(estate: Base58): Promise<Letter[]> {
  const sb = getSupabase();
  if (!sb) return [...(mem.get(estate)?.values() ?? [])].map((l) => structuredClone(l));
  const { data, error } = await sb.from("family_letters").select("*").eq("estate", estate).limit(MAX_PER_ESTATE);
  warn("getLetters", error);
  if (error) throw new Error("Letters could not be loaded. Please try again.");
  return ((data ?? []) as Row[]).map(fromRow);
}

/**
 * Stores the letter when the stored row still has version `prev` (0 = no row yet: a new letter, or the first change
 * to a seeded demo letter). Returns false when someone saved first.
 */
export async function putLetter(l: Letter, prev = l.version - 1): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    // Room is made only inside this family, and only by letting go of its oldest tombstone (a deleted letter);
    // nobody's letters are pushed out for another family's (plan §18.9 M6).
    if (!mem.has(l.estate) && mem.size >= MAX_ESTATES) throw new StoreFull("letters");
    const m = mem.get(l.estate) ?? new Map<string, Letter>();
    if ((m.get(l.id)?.version ?? 0) !== prev) return false;
    if (!m.has(l.id) && m.size >= MAX_PER_ESTATE) {
      const tomb = [...m.values()].filter((x) => x.deleted).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!tomb) throw new StoreFull("letters");
      m.delete(tomb.id);
    }
    m.set(l.id, structuredClone(l));
    mem.set(l.estate, m);
    return true;
  }
  const row = toRow(l);
  if (prev === 0) {
    const { error } = await sb.from("family_letters").insert(row);
    if (error && /duplicate|unique/i.test(error.message)) return false;
    warn("insert", error);
    if (error) throw new Error("The letter could not be saved. Please try again.");
    return true;
  }
  const { data, error } = await sb.from("family_letters").update(row).eq("estate", l.estate).eq("id", l.id).eq("version", prev).select("id");
  warn("update", error);
  if (error) throw new Error("The letter could not be saved. Please try again.");
  return (data ?? []).length === 1;
}

/** Marks a letter as seen open (sticky): only the first time. */
export async function markOpened(estate: Base58, id: string, at: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const l = mem.get(estate)?.get(id);
    if (l && l.openedAt === null) l.openedAt = at;
    return;
  }
  const { error } = await sb.from("family_letters").update({ opened_at: at }).eq("estate", estate).eq("id", id).is("opened_at", null);
  warn("markOpened", error);
}

/** Tests only. */
export function resetLettersMemory() { mem.clear(); }
