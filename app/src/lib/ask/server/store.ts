import "server-only";
/**
 * "Ask for money" notes (purpose, currency typed, the owner's decline) in Supabase (supabase/migrations/0005_asks.sql),
 * or in memory when Supabase is not configured (then they last as long as the server instance; the browser that asked
 * keeps its own copy too, lib/service/chain-ask.ts).
 */
import { getSupabase } from "@/lib/supabase";
import type { AskNote } from "../types";
import { roomFor } from "@/lib/server/memory-limits";

export type StoredAsk = AskNote & { estate: string };

const mem = new Map<string, StoredAsk>();
/** Without Supabase: notes kept for one estate (as many as the Supabase list returns), and for all of them. */
export const MAX_PER_ESTATE = 200;
const MAX_MEM = 20_000;

/**
 * Room in memory for `claim`: an estate at its limit lets go of its own oldest note (one with no decline first); a new
 * estate is refused when the store is full. One family never pushes out another's notes (plan §18.9 M6).
 */
const byEstate = new Map<string, Set<string>>();
function makeRoom(estate: string, claim: string): void {
  if (mem.has(claim)) return;
  const claims = byEstate.get(estate) ?? new Set<string>();
  if (claims.size >= MAX_PER_ESTATE) {
    const own = [...claims].map((c) => mem.get(c)!).sort((x, y) => x.createdAt - y.createdAt);
    const gone = (own.find((n) => n.declinedAt === null) ?? own[0]).claim;
    mem.delete(gone);
    claims.delete(gone);
  } else {
    roomFor(mem, claim, MAX_MEM, "requests");
  }
  claims.add(claim);
  byEstate.set(estate, claims);
}

function warn(what: string, err: { message: string } | null) {
  if (err) console.warn(`[asks] ${what} failed: ${err.message}`);
}

type Row = { estate: string; claim: string; purpose: string; currency: string; typed: number; attachment: boolean; created_at: number; declined_at: number | null };
const strip = ({ estate: _estate, ...n }: StoredAsk): AskNote => { void _estate; return n; };
const fromRow = (r: Row): StoredAsk => ({
  estate: r.estate, claim: r.claim, purpose: r.purpose, currency: r.currency === "ZAR" ? "ZAR" : "USDT", typed: Number(r.typed),
  attachment: !!r.attachment, createdAt: Number(r.created_at), declinedAt: r.declined_at === null ? null : Number(r.declined_at),
});

export async function listAsks(estate: string): Promise<AskNote[]> {
  const sb = getSupabase();
  if (!sb) return [...mem.values()].filter((n) => n.estate === estate).map(strip);
  const { data, error } = await sb.from("asks").select("*").eq("estate", estate).order("created_at", { ascending: false }).limit(200);
  warn("listAsks", error);
  return (data ?? []).map((r) => strip(fromRow(r as Row)));
}

export async function getAsk(claim: string): Promise<StoredAsk | null> {
  const sb = getSupabase();
  if (!sb) return mem.get(claim) ?? null;
  const { data, error } = await sb.from("asks").select("*").eq("claim", claim).maybeSingle();
  warn("getAsk", error);
  return data ? fromRow(data as Row) : null;
}

/** Saves the asker's note. A decline already recorded is kept. */
export async function saveAsk(n: StoredAsk): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const prev = mem.get(n.claim);
    makeRoom(n.estate, n.claim);
    mem.set(n.claim, { ...n, declinedAt: prev?.declinedAt ?? n.declinedAt });
    return;
  }
  const { error } = await sb.from("asks").upsert({
    estate: n.estate, claim: n.claim, purpose: n.purpose, currency: n.currency, typed: n.typed, attachment: n.attachment, created_at: n.createdAt,
  }, { onConflict: "claim" });
  warn("saveAsk", error);
}

export async function declineAsk(estate: string, claim: string, at: number, createdAt: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const prev = mem.get(claim);
    makeRoom(estate, claim);
    mem.set(claim, prev ? { ...prev, declinedAt: at } : { estate, claim, purpose: "", currency: "USDT", typed: 0, attachment: true, createdAt, declinedAt: at });
    return;
  }
  const { error } = await sb.from("asks").upsert({ estate, claim, declined_at: at, created_at: createdAt }, { onConflict: "claim", ignoreDuplicates: false });
  warn("declineAsk", error);
}

/** Tests only. */
export function resetAskMemory() { mem.clear(); byEstate.clear(); }
