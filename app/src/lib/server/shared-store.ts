import "server-only";
/**
 * Single-use tokens and allowances shared by every server instance (supabase/migrations/0009_server_limits.sql).
 *
 * Each function answers null when there is no shared store (not configured, migration not applied, or not answering);
 * the caller then falls back to its own instance plus, where money is at stake, a backstop read from the chain.
 * Keys are HMACs under the service-role key, so the table holds no IP address, wallet or signature.
 */
import { createHmac } from "node:crypto";
import { getSupabase } from "../supabase";
import { withDeadline } from "./deadline";

const TIMEOUT_MS = 3_000;

export interface Take { key: string; max: number; windowSecs: number }
export type Taken = { ok: true } | { ok: false; retryAfterSecs: number };

const hashed = (key: string) => createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").update(key, "utf8").digest("hex");

async function call(fn: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const sb = getSupabase();
    if (!sb) return null;
    const { data, error } = await withDeadline(Promise.resolve(sb.rpc(fn, args)), TIMEOUT_MS, fn);
    if (!error) return data;
    console.warn(`[shared-store] ${fn} failed: ${error.message}`);
  } catch (e) {
    console.warn(`[shared-store] ${fn} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

/** True the first time, false on a repeat, null without a shared store. */
export async function claimSharedOnce(key: string, ttlSecs: number): Promise<boolean | null> {
  const r = await call("heirloom_use_once", { p_key: hashed(key), p_ttl_secs: Math.ceil(ttlSecs) });
  return typeof r === "boolean" ? r : null;
}

/** One from every allowance or from none; null without a shared store. */
export async function takeShared(takes: Take[]): Promise<Taken | null> {
  const r = await call("heirloom_take", {
    p_keys: takes.map((t) => hashed(t.key)),
    p_maxes: takes.map((t) => t.max),
    p_windows: takes.map((t) => Math.ceil(t.windowSecs)),
  });
  if (typeof r !== "number") return null;
  return r === 0 ? { ok: true } : { ok: false, retryAfterSecs: r };
}
