import "server-only";
/**
 * /api/reasons (app/api/reasons/route.ts re-exports it): the written reasons of disputes and objections (plan §18.9
 * M9). On-chain an Objection holds only the reason's SHA-256, so without this the words stayed on the writer's device.
 *
 * GET ?estate=… → { reasons: [{ target, hash, reason }], durable }, for members only (a read pass, lib/access).
 * POST { estate, target, reason }, signed as the action "reason" over `${target}|${sha256(reason)}` (lib/access):
 *  - the text is 1 to 600 characters and its SHA-256 (UTF-8, as written) is the hash;
 *  - on-chain, the Objection at ["objection", target] belongs to this estate, was raised by the signer, and holds
 *    exactly that hash; so only the person who raised a challenge saves its words, once it is on-chain.
 * → { ok, durable }. In Supabase (supabase/migrations/0010_challenge_reasons.sql) when it is configured, else in this
 * server's memory (bounded; `durable: false`), so the writer's device should keep its own copy too.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { handler, HttpError, isChainMode, json, parseJson, rateLimit } from "../api/http";
import { getSupabase } from "../supabase";
import { hex, key, type Raw } from "../chain/decoders";
import { getIdl } from "../chain/idl";
import { objectionPda } from "../chain/pda";
import { fetchAccountRaw } from "../chain/reads";
import { requireMember, verifyAction, type MemberCheck } from "../access/server";
import { actionBody } from "../access/messages";
import { roomFor } from "./memory-limits";

export const REASON_MAX = 600;
const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const body = z.object({ estate: addr, target: addr, reason: z.string().min(1).max(REASON_MAX) });

export interface ChallengeReason { target: string; hash: string; reason: string }

/** Without Supabase: reasons kept for one estate and in all. */
const MAX_PER_ESTATE = 200;
const MAX_ESTATES = 5_000;
const mem = new Map<string, Map<string, ChallengeReason & { at: number }>>();

export const reasonHash = (reason: string) => createHash("sha256").update(reason, "utf8").digest("hex");

async function list(estate: string): Promise<ChallengeReason[]> {
  const sb = getSupabase();
  if (!sb) return [...(mem.get(estate)?.values() ?? [])].map(({ target, hash, reason }) => ({ target, hash, reason }));
  const { data, error } = await sb.from("challenge_reasons").select("target, reason_hash, reason").eq("estate", estate).limit(MAX_PER_ESTATE);
  if (error) console.warn(`[challenge_reasons] list failed: ${error.message}`);
  return ((data ?? []) as { target: string; reason_hash: string; reason: string }[]).map((r) => ({ target: r.target, hash: r.reason_hash, reason: r.reason }));
}

async function save(estate: string, writer: string, r: ChallengeReason, at: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    roomFor(mem, estate, MAX_ESTATES, "reasons");
    const m = mem.get(estate) ?? new Map<string, ChallengeReason & { at: number }>();
    const k = `${r.target}:${r.hash}`;
    if (!m.has(k) && m.size >= MAX_PER_ESTATE) {
      // Only this family's own oldest reason makes room.
      const oldest = [...m.entries()].sort(([, a], [, b]) => a.at - b.at)[0];
      m.delete(oldest[0]);
    }
    m.set(k, { ...r, at });
    mem.set(estate, m);
    return;
  }
  const { error } = await sb.from("challenge_reasons").upsert(
    { estate, target: r.target, reason_hash: r.hash, reason: r.reason, writer, created_at: at }, { onConflict: "estate,target,reason_hash" },
  );
  if (error) {
    console.warn(`[challenge_reasons] save failed: ${error.message}`);
    throw new HttpError(503, "The reason could not be saved. Please try again.", "busy", 30);
  }
}

export interface ReasonsRouteDeps {
  member?: MemberCheck;
  fetchRaw(type: string, address: string): Promise<Raw | null>;
  chain(): boolean;
  now(): number;
}
const defaults: ReasonsRouteDeps = { fetchRaw: fetchAccountRaw, chain: isChainMode, now: () => Date.now() };

export function reasonsRoutes(deps: ReasonsRouteDeps = defaults) {
  const GET = handler(async (req) => {
    rateLimit(req, "reasons", 60);
    const estate = addr.parse(new URL(req.url).searchParams.get("estate"));
    await requireMember(req, estate, deps.member);
    return json({ reasons: await list(estate), durable: getSupabase() !== null });
  });

  const POST = handler(async (req) => {
    rateLimit(req, "reasons-write", 20);
    if (!deps.chain()) throw new HttpError(503, "The demo keeps reasons in the browser.", "unavailable");
    const b = await parseJson(req, body, 4_000);
    const hash = reasonHash(b.reason);
    const wallet = await verifyAction(req, "reason", b.estate, actionBody.reason({ target: b.target, hash }), deps.now());
    const o = await deps.fetchRaw("Objection", objectionPda(new PublicKey(getIdl().address), b.target).toBase58());
    if (!o || key(o, "estate") !== b.estate || key(o, "target") !== b.target) throw new HttpError(404, "That challenge is not on-chain.", "not_found");
    if (key(o, "monitor") !== wallet) throw new HttpError(403, "Only the person who raised it can save its reason.", "forbidden");
    if (hex(o, "reason_hash") !== hash) throw new HttpError(409, "This text is not the reason recorded on-chain.", "hash_mismatch");
    await save(b.estate, wallet, { target: b.target, hash, reason: b.reason }, Math.floor(deps.now() / 1000));
    return json({ ok: true, durable: getSupabase() !== null });
  });

  return { GET, POST };
}

/** Tests only. */
export function resetReasonsMemory(): void { mem.clear(); }
