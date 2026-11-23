/**
 * Shared contract for /api/assets/photos (browser and server). Requests that change photos are signed by the
 * owner's WDK wallet over (action, estate, wallet, time, body hash), in the same header format as the legacy
 * routes (`x-heirloom-auth`), but with its own message prefix so a signature can never be replayed across APIs.
 */
import type { AssetKind, AssetMediaInfo } from "../guardians/types";
import type { AssetSpec, PhotoLabel } from "../assets/spec";

export { AUTH_HEADER, encodeAuth, type LegacyAuth as MediaAuth } from "../legacy/auth-message";

export const ASSET_KINDS: readonly AssetKind[] = ["Car", "Motorbike", "Furniture", "Jewellery", "Electronics", "Other"];
export const isAssetKind = (k: unknown): k is AssetKind => typeof k === "string" && (ASSET_KINDS as readonly string[]).includes(k);
/** Kinds the AI car valuation understands. */
export const VALUED_KINDS: readonly AssetKind[] = ["Car", "Motorbike"];

export type MediaAction = "photos.upload" | "photos.delete";

export function mediaAuthMessage(action: MediaAction, estate: string, wallet: string, ts: number, bodyHash: string): string {
  return `Heirloom asset photos\naction:${action}\nestate:${estate}\nwallet:${wallet}\nts:${ts}\nbody:${bodyHash}`;
}

/**
 * What the upload signature covers. The server recomputes the file hashes from the bytes it received.
 * `files[i]` is the SHA-256 of file i AS SENT. For a WebP that is also the stored photo's hash. For a JPEG/PNG/HEIC
 * original (browsers that cannot encode WebP), the server converts it with sharp and stores and hashes ONLY the
 * WebP: the signature covers the original's SHA-256, the response returns the WebP's SHA-256 (in the same position
 * of the set), and that WebP hash is the one that goes into photosRoot and on-chain. `order` may name a new photo
 * by its sent hash; already-stored photos are named by their WebP hash.
 * `labels[k]` is the label of `order[k]` ("" = none); `spec` is the spec sheet (null = none). Both are signed and
 * both are part of the media root that goes on-chain (lib/assets/spec.ts).
 */
export interface UploadManifest {
  asset: string; kind: AssetKind; title: string; description?: string; order: string[]; files: string[];
  labels?: (PhotoLabel | "")[]; spec?: AssetSpec | null;
}
export const manifestText = (m: UploadManifest) => JSON.stringify({
  asset: m.asset, kind: m.kind, title: m.title, description: m.description ?? "", order: m.order, files: m.files,
  labels: m.labels ?? m.order.map(() => ""), spec: m.spec ?? null,
});
/** The manifest text is signed and parsed before any photo is read: big enough for 24 photos and a full spec sheet. */
export const MAX_MANIFEST_CHARS = 16_000;
export const MAX_DESCRIPTION = 600;

/** AssetMediaInfo plus the owner's description (kept off-chain only; not part of the on-chain root). */
export type AssetMediaView = AssetMediaInfo & { description?: string };

export interface DeleteBody { asset: string; sha256: string }

export interface PhotosListResponse { assets: AssetMediaView[] }
export interface PhotosProbeResponse { available: boolean }

/** Vercel caps a request body at 4.5 MB, so larger sets go up in several requests. */
export const MAX_REQUEST_BYTES = 3_800_000;
