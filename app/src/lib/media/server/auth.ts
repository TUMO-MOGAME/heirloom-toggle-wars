import "server-only";
/**
 * Authorises photo writes. Same model as /api/legacy/*: an ed25519 signature by the wallet over
 * (action, estate, wallet, time, body hash), at most 5 minutes old and single use; then the estate is read from
 * Solana and the wallet must be its owner while the estate is still Active, and the asset must belong to it.
 * Mock deployments are refused unless LEGACY_DEMO_WRITES=1 (demo only; the persona's role is trusted).
 */
import { HttpError, isChainMode } from "@/lib/api/http";
import { loadSnapshot } from "@/lib/server/estate";
import { AUTH_MAX_SKEW_MS } from "@/lib/legacy/auth-message";
import { demoWritesAllowed, parseAuthHeader, verifyEd25519 } from "@/lib/legacy/server/auth";
import { mediaAuthMessage, type MediaAction } from "../api";
import { createNonces } from "@/lib/access/nonces";

export interface PhotoOwner { wallet: string; estate: string; demo: boolean }

const firstUse = createNonces("media", AUTH_MAX_SKEW_MS * 2);

export const photosAvailable = () => isChainMode() || demoWritesAllowed();

export async function authorizeOwner(req: Request, action: MediaAction, bodyHash: string, asset: string, now = Date.now()): Promise<PhotoOwner> {
  const a = parseAuthHeader(req);
  if (!isChainMode()) {
    if (!demoWritesAllowed()) throw new HttpError(503, "Photo uploads need the live network.", "unavailable");
    if (a.demoRole !== "owner") throw new HttpError(403, "Only the estate owner can change the photos.", "forbidden");
    return { wallet: a.wallet, estate: a.estate, demo: true };
  }
  if (a.sig === "demo") throw new HttpError(401, "A wallet signature is required.", "unauthorized");
  if (Math.abs(now - a.ts) > AUTH_MAX_SKEW_MS) throw new HttpError(401, "This request has expired. Check your phone's clock and try again.", "expired");
  if (!verifyEd25519(a.wallet, mediaAuthMessage(action, a.estate, a.wallet, a.ts, bodyHash), a.sig)) throw new HttpError(401, "The wallet signature does not match.", "unauthorized");
  if (!(await firstUse(a.sig, now))) throw new HttpError(401, "This request was already used. Please try again.", "replay");

  const snap = await loadSnapshot(a.estate).catch(() => null);
  if (!snap) throw new HttpError(404, "Estate not found on-chain.", "not_found");
  if (snap.estate.owner !== a.wallet) throw new HttpError(403, "Only the estate owner can change the photos.", "forbidden");
  if (snap.estate.status !== "Active") throw new HttpError(409, "Photos can only be changed while the estate is active.", "BadStatus");
  if (!snap.assets.some((x) => x.address === asset)) throw new HttpError(404, "This asset is not part of the estate.", "not_found");
  return { wallet: a.wallet, estate: a.estate, demo: false };
}
