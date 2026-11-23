/**
 * Signed writes to /api/estate-meta (the off-chain display names of an estate). Shared by the browser (the chain
 * service signs with the acting wallet) and the server route (verifies), like lib/letters/canonical.ts.
 *
 * - "save": the estate owner saves the names (owner, trusted people, asset titles, names by wallet) and, once, the
 *   signed will draft. Only the owner's wallet may do this.
 * - "buyer-name": a buyer who has an offer on one of the estate's assets gives the name the family sees beside the
 *   offer. It never replaces a name the owner gave.
 *
 * The signed message binds the action, estate, wallet, time and a SHA-256 of the canonical JSON body.
 */
import type { Base58 } from "../types";
import { canonicalJson, sha256Hex } from "../agent/hash";

export type MetaAction = "save" | "buyer-name";
export const META_MAX_SKEW_MS = 5 * 60 * 1000;

export function metaMessage(action: MetaAction, estate: Base58, wallet: Base58, ts: number, bodyHex: string): string {
  return `Heirloom estate names\naction:${action}\nestate:${estate}\nwallet:${wallet}\nts:${ts}\nbody:${bodyHex}`;
}

/** The text a "save" or "buyer-name" signs: the canonical JSON of its payload (`meta`, or `{ asset, name }`). */
export const metaBody = (payload: unknown) => canonicalJson(payload);

export interface MetaSigner { address: Base58; signMessage(message: string): Promise<string> }

/** The request body for a signed write. */
export async function signedMetaRequest(
  signer: MetaSigner, action: MetaAction, estate: Base58, payload: Record<string, unknown>, now = Date.now(),
): Promise<Record<string, unknown>> {
  const ts = now;
  const sig = await signer.signMessage(metaMessage(action, estate, signer.address, ts, await sha256Hex(metaBody(payload))));
  return action === "save"
    ? { action, estate, wallet: signer.address, ts, sig, meta: payload }
    : { action, estate, wallet: signer.address, ts, sig, ...payload };
}
