/**
 * The written reasons of disputes and objections (plan §18.9 M9). On-chain an Objection holds only the reason's
 * SHA-256, so the people who vote saw no reason on other devices. After the transaction lands, the person who raised
 * it saves the words with /api/reasons (members only, checked against the on-chain hash by the server); the voters'
 * devices read them with their read pass and keep only text whose SHA-256 is the hash on-chain.
 *
 * Request shape (server: lib/server/reasons.ts):
 *  - POST /api/reasons, JSON { estate, target, reason }, signed action "reason" over `${target}|${sha256(reason)}`
 *    in the x-heirloom-action header (lib/access);
 *  - GET /api/reasons?estate=… with the read pass header → { reasons: [{ target, hash, reason }], durable }.
 */
import type { Base58 } from "../types";
import { sha256Hex } from "../agent/hash";
import { actionHeaders, readHeaders } from "../access/client";

interface Signer { address: Base58; signMessage(message: string): Promise<string> }
type Fetch = typeof fetch;

/** The body the "reason" action signs (as lib/access/messages.ts actionBody.reason on the server's side). */
export const reasonBody = (target: Base58, hash: string) => `${target}|${hash}`;

/** Saves the words of one's own dispute or objection. Throws when the server refuses; the caller keeps its own copy. */
export async function saveReason(signer: Signer, estate: Base58, target: Base58, reason: string, f: Fetch = fetch): Promise<void> {
  const hash = await sha256Hex(reason);
  const headers = await actionHeaders(signer, "reason", estate, reasonBody(target, hash));
  const res = await f("/api/reasons", { method: "POST", cache: "no-store", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ estate, target, reason }) });
  if (!res.ok) throw new Error(`The reason was not saved (${res.status}).`);
}

/** The estate's reasons by their hash, only those whose text matches it. Empty when they can't be read. */
export async function loadReasons(estate: Base58, f: Fetch = fetch): Promise<Record<string, string>> {
  try {
    const res = await f(`/api/reasons?estate=${estate}`, { cache: "no-store", headers: readHeaders() });
    if (!res.ok) return {};
    const data = (await res.json()) as { reasons?: { hash?: unknown; reason?: unknown }[] };
    const out: Record<string, string> = {};
    for (const r of data.reasons ?? []) {
      if (typeof r.hash !== "string" || typeof r.reason !== "string") continue;
      if ((await sha256Hex(r.reason)) === r.hash) out[r.hash] = r.reason;
    }
    return out;
  } catch {
    return {};
  }
}
