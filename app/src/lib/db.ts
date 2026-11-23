import "server-only";
/**
 * Off-chain metadata in Supabase Postgres (schema: supabase/migrations/0001_init.sql): display names,
 * will drafts, agent reports (full JSON; the chain has only the hash), evidence index, chat/voice
 * transcripts. Every function falls back to an in-memory store when Supabase is not configured.
 */
import { getSupabase } from "./supabase";
import type { AgentReport, WillDraft } from "./types";
import type { SpecialistName } from "./voice/types";
import { chainConfig } from "./chain/config";
import { DEVNET_DEMO_META, DEVNET_FIRST_META, DEVNET_PREV_META } from "./chain/demo-estate";
import { roomFor } from "./server/memory-limits";

/** Without Supabase: estates whose names are kept, and agent reports kept for one estate and in all (plan §18.9 M6). */
const MAX_MEM_ESTATES = 10_000;
export const MAX_MEM_REPORTS_PER_ESTATE = 500;
const MAX_MEM_REPORTS = 20_000;

export interface EstateMeta {
  estate: string;
  ownerWallet: string;
  ownerName: string;
  verifierNames: [string, string, string];
  assetTitles: Record<string, string>;
  buyerNames: Record<string, string>;
  /** Milliseconds: when the owner saved these names. A save names the one it was built on (lib/estate-meta). */
  updatedAt?: number;
  /**
   * Names in `buyerNames` that a buyer gave themselves (/api/estate-meta buyer-name), by wallet. Shown like the others,
   * but never trusted as who someone is: not by the reviewer, not to match a Legacy Book's child (plan §18.9).
   */
  selfNamed?: Record<string, string>;
}

/** The names the owner gave (or kept): `buyerNames` without the ones buyers gave themselves. */
export function trustedNames(m: Pick<EstateMeta, "buyerNames" | "selfNamed"> | null | undefined): Record<string, string> {
  if (!m) return {};
  return Object.fromEntries(Object.entries(m.buyerNames).filter(([w, n]) => m.selfNamed?.[w] !== n));
}

/** In the table the self-given names ride in buyer_names under this prefix, so no migration is needed. */
const SELF = "self:";

export interface ReportRow {
  reportHash: string;
  purpose: "death" | "claim" | "hardship" | "valuation" | "offers";
  estate: string | null;
  subject: string | null;
  evidencePath: string | null;
  evidenceSha256: string | null;
  report: AgentReport;
  txSignature: string | null;
}

export interface TranscriptRow {
  sessionId: string;
  channel: "text" | "voice";
  persona: string | null;
  estate: string | null;
  role: "user" | "agent";
  specialist: SpecialistName | null;
  text: string;
}

// Will drafts, the evidence index and transcripts are only ever read from Supabase, so without it they are not kept.
const mem = {
  estates: new Map<string, EstateMeta>(),
  reports: new Map<string, ReportRow>(),
};
// Devnet without Supabase: keep the seeded demo family's names across restarts (fictional people; see demo-estate.ts).
if (chainConfig.cluster === "devnet") for (const m of [DEVNET_DEMO_META, DEVNET_PREV_META, DEVNET_FIRST_META]) mem.estates.set(m.estate, m);

function warn(what: string, err: { message: string } | null) {
  if (err) console.warn(`[db] ${what} failed: ${err.message}`);
}

/** False while names live only in this server's memory (no Supabase): a restart loses them. */
export const metaIsDurable = (): boolean => getSupabase() !== null;

/**
 * Stores names only if what is stored is still `prev` (null: nothing stored), so an older copy can never replace a
 * newer one, even across instances. Returns false when it changed meanwhile; throws when the store fails.
 */
export async function saveEstateMeta(m: EstateMeta, prev: EstateMeta | null): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    const held = mem.estates.get(m.estate) ?? null;
    if (!held !== !prev || (held?.updatedAt ?? 0) !== (prev?.updatedAt ?? 0)) return false;
    roomFor(mem.estates, m.estate, MAX_MEM_ESTATES, "names");
    mem.estates.set(m.estate, m);
    return true;
  }
  const row = {
    estate: m.estate, owner_wallet: m.ownerWallet, owner_name: m.ownerName, verifier_names: m.verifierNames,
    asset_titles: m.assetTitles,
    buyer_names: { ...m.buyerNames, ...Object.fromEntries(Object.entries(m.selfNamed ?? {}).map(([w, n]) => [`${SELF}${w}`, n])) },
    updated_at: new Date(m.updatedAt ?? Date.now()).toISOString(),
  };
  const table = sb.from("estate_meta");
  const at = prev?.updatedAt ?? 0;
  const { data, error } = prev
    // A millisecond range: Postgres keeps microseconds, JavaScript doesn't.
    ? await table.update(row).eq("estate", m.estate).gte("updated_at", new Date(at).toISOString()).lt("updated_at", new Date(at + 1).toISOString()).select("estate")
    : await table.upsert(row, { onConflict: "estate", ignoreDuplicates: true }).select("estate");
  if (error) throw new Error(`Could not save the names: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** `strict` throws when the store can't be read, so "couldn't read" is never taken for "nothing saved". */
export async function getEstateMeta(estate: string, opts: { strict?: boolean } = {}): Promise<EstateMeta | null> {
  const sb = getSupabase();
  if (!sb) return mem.estates.get(estate) ?? null;
  const { data, error } = await sb.from("estate_meta").select("*").eq("estate", estate).maybeSingle();
  if (error && opts.strict) throw new Error(`Could not read the names: ${error.message}`);
  warn("getEstateMeta", error);
  if (!data) return null;
  return {
    estate: data.estate, ownerWallet: data.owner_wallet, ownerName: data.owner_name, verifierNames: data.verifier_names,
    assetTitles: data.asset_titles ?? {},
    ...(() => {
      const all = (data.buyer_names ?? {}) as Record<string, string>;
      const own = Object.entries(all).filter(([k]) => !k.startsWith(SELF));
      const self = Object.entries(all).filter(([k]) => k.startsWith(SELF)).map(([k, n]) => [k.slice(SELF.length), n]);
      return { buyerNames: Object.fromEntries(own), ...(self.length ? { selfNamed: Object.fromEntries(self) } : {}) };
    })(),
    updatedAt: data.updated_at ? Date.parse(data.updated_at) : 0,
  };
}

export async function saveWillDraft(ownerWallet: string | null, draft: WillDraft, willHash: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) { void ownerWallet; void draft; void willHash; return; }
  const { error } = await sb.from("will_drafts").insert({ owner_wallet: ownerWallet, draft, will_hash: willHash });
  warn("saveWillDraft", error);
}

/** False when the store refused it (the caller then records nothing on-chain). */
export async function saveReport(r: ReportRow): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) {
    if (!mem.reports.has(r.reportHash)) {
      const own = [...mem.reports.values()].filter((x) => x.estate === r.estate);
      // A family at its limit lets go of its own oldest report; a full store refuses a new one (nothing is sent then).
      if (own.length >= MAX_MEM_REPORTS_PER_ESTATE) mem.reports.delete(own[0].reportHash);
      else if (mem.reports.size >= MAX_MEM_REPORTS) return false;
    }
    mem.reports.set(r.reportHash, r);
    return true;
  }
  const { error } = await sb.from("agent_reports").upsert({
    report_hash: r.reportHash, purpose: r.purpose, estate: r.estate, subject: r.subject, evidence_path: r.evidencePath,
    evidence_sha256: r.evidenceSha256, report: r.report, tx_signature: r.txSignature,
  });
  warn("saveReport", error);
  return !error;
}

/** With `estate`, only reports made for that estate: hashes are public on-chain, the reports are not. */
export async function getReports(hashes: string[], estate?: string): Promise<Record<string, AgentReport>> {
  const out: Record<string, AgentReport> = {};
  if (hashes.length === 0) return out;
  const sb = getSupabase();
  if (!sb) {
    for (const h of hashes) { const r = mem.reports.get(h); if (r && (!estate || r.estate === estate)) out[h] = r.report; }
    return out;
  }
  // In lists of 100, so a long list stays a short query string.
  for (let i = 0; i < hashes.length; i += 100) {
    let query = sb.from("agent_reports").select("report_hash, report").in("report_hash", hashes.slice(i, i + 100));
    if (estate) query = query.eq("estate", estate);
    const { data, error } = await query;
    warn("getReports", error);
    for (const row of data ?? []) out[row.report_hash as string] = row.report as AgentReport;
  }
  return out;
}

export async function recordEvidence(path: string, sha256: string, purpose: string, mime: string, size: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("evidence").upsert({ path, sha256, purpose, mime, size });
  warn("recordEvidence", error);
}

export async function saveTranscript(rows: TranscriptRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from("transcripts").insert(rows.map((r) => ({
    session_id: r.sessionId, channel: r.channel, persona: r.persona, estate: r.estate, role: r.role, specialist: r.specialist, text: r.text,
  })));
  warn("saveTranscript", error);
}
