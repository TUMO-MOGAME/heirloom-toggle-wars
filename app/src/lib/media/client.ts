/**
 * Browser client for /api/assets/photos. Uploads already-converted WebP photos (see ./webp.ts) for one asset,
 * in batches small enough for the hosting body limit, each request signed by the owner's wallet.
 * Without a photo server (the public mock demo), `localPhotos` keeps the photos on this device for the session.
 */
import { sha256Hex } from "../agent/hash";
import type { AssetKind, AssetPhoto } from "../guardians/types";
import {
  AUTH_HEADER, encodeAuth, manifestText, MAX_REQUEST_BYTES, mediaAuthMessage,
  type AssetMediaView, type MediaAction, type PhotosListResponse, type PhotosProbeResponse,
} from "./api";
import { type WebpPhoto } from "./webp";
import { mediaRootHex, withLabel, type AssetSpec, type PhotoLabel } from "../assets/spec";

export interface MediaSigner {
  estate: string;
  wallet: string;
  /** Hex ed25519 signature, or "demo" on a demo deployment. */
  sign(message: string): Promise<string>;
  demoRole?: "owner" | "child";
  demoLabel?: string;
}

/**
 * One photo in the final, ordered set: already on the server, a new WebP to upload, or a "raw" JPEG/PNG/HEIC
 * that the server converts to WebP (browsers that cannot encode WebP). A raw photo's sha256 is of the bytes sent.
 */
export type PhotoItem = ({ kind: "stored"; photo: AssetPhoto } | { kind: "new" | "raw"; photo: WebpPhoto }) & { label?: PhotoLabel };

/** What one save sends: the ordered photos (each with its label) and the spec sheet. */
export interface MediaInput { asset: string; kind: AssetKind; title: string; description?: string; items: PhotoItem[]; spec?: AssetSpec }
const shaOf = (p: PhotoItem) => p.photo.sha256;

async function header(s: MediaSigner, action: MediaAction, bodyHash: string): Promise<Record<string, string>> {
  const ts = Date.now();
  const sig = await s.sign(mediaAuthMessage(action, s.estate, s.wallet, ts, bodyHash));
  return { [AUTH_HEADER]: encodeAuth({ estate: s.estate, wallet: s.wallet, ts, sig, demoRole: s.demoRole, demoLabel: s.demoLabel }) };
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const err = new Error(data.error ?? `Request failed (${res.status})`) as Error & { code?: string; status?: number };
  err.code = data.code; err.status = res.status;
  throw err;
}

/** Splits the new photos into batches under the request limit (each photo is at most 1.5 MB). */
export function batches(photos: WebpPhoto[], limit = MAX_REQUEST_BYTES): WebpPhoto[][] {
  const out: WebpPhoto[][] = [];
  let cur: WebpPhoto[] = [], size = 0;
  for (const p of photos) {
    if (cur.length && size + p.bytes > limit) { out.push(cur); cur = []; size = 0; }
    cur.push(p); size += p.bytes;
  }
  if (cur.length) out.push(cur);
  return out;
}

export const photosApi = {
  /** Is a photo server available here (chain mode, or a demo deployment that allows demo writes)? */
  async probe(): Promise<boolean> {
    const res = await fetch("/api/assets/photos", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return false;
    return ((await res.json().catch(() => ({ available: false }))) as PhotosProbeResponse).available === true;
  },

  /** Photos (short-lived signed URLs) for every asset of an estate. Public: buyers see them too. */
  async list(estate: string): Promise<AssetMediaView[]> {
    const res = await check(await fetch(`/api/assets/photos?estate=${encodeURIComponent(estate)}`, { cache: "no-store" }));
    return ((await res.json()) as PhotosListResponse).assets;
  },

  /**
   * Makes the server's photo set for `asset` equal `items`, in order. New photos are uploaded in batches; each
   * request sets the order to "everything uploaded so far", so a failure part-way leaves a valid, shorter set.
   * Returns the final set (with signed URLs) and its root, ready for `setAssetMedia`.
   */
  async save(s: MediaSigner, input: MediaInput, onProgress?: (done: number, total: number) => void): Promise<AssetMediaView> {
    const fresh = input.items.filter((i): i is Extract<PhotoItem, { kind: "new" | "raw" }> => i.kind !== "stored").map((i) => i.photo);
    // Sent-file SHA-256 → stored WebP SHA-256 (they differ for raw photos the server converted).
    const stored = new Map<string, string>();
    const groups = fresh.length ? batches(fresh) : [[]];
    const sent = new Set<string>();
    let last: AssetMediaView | null = null;
    let done = 0;
    onProgress?.(0, fresh.length);
    for (const group of groups) {
      group.forEach((p) => sent.add(p.sha256));
      const kept = input.items.filter((i) => i.kind === "stored" || sent.has(shaOf(i)));
      const order = kept.map((i) => stored.get(shaOf(i)) ?? shaOf(i));
      const manifest = {
        asset: input.asset, kind: input.kind, title: input.title, description: input.description ?? "", order, files: group.map((p) => p.sha256),
        labels: kept.map((i) => i.label ?? ("" as const)), spec: input.spec ?? null,
      };
      const form = new FormData();
      form.set("manifest", manifestText(manifest));
      group.forEach((p, i) => form.append("photos", p.blob, `photo-${i + 1}`));
      const res = await fetch("/api/assets/photos", { method: "POST", body: form, headers: await header(s, "photos.upload", await sha256Hex(manifestText(manifest))) });
      last = (await (await check(res)).json()) as AssetMediaView;
      // The response lists the set in the order sent, so position k of `order` became photos[k].
      order.forEach((h, k) => { const got = last!.photos[k]?.sha256; if (got && got !== h) stored.set(h, got); });
      done += group.length;
      onProgress?.(done, fresh.length);
    }
    return last!;
  },

  async remove(s: MediaSigner, asset: string, sha256: string): Promise<AssetMediaView> {
    const text = JSON.stringify({ asset, sha256 });
    const res = await fetch("/api/assets/photos", {
      method: "DELETE", cache: "no-store", body: text,
      headers: { "content-type": "application/json", ...(await header(s, "photos.delete", await sha256Hex(text))) },
    });
    return (await check(res)).json() as Promise<AssetMediaView>;
  },
};

/**
 * No photo server (public mock demo): the set stays in this browser tab as object URLs. Clearly a demo path;
 * the photos are never sent anywhere.
 */
export async function localPhotos(input: MediaInput): Promise<AssetMediaView> {
  const photos: AssetPhoto[] = input.items.map((i) => withLabel<AssetPhoto>(i.kind === "stored" ? i.photo : {
    sha256: i.photo.sha256, url: URL.createObjectURL(i.photo.blob), width: i.photo.width, height: i.photo.height, bytes: i.photo.bytes,
  }, i.label));
  return {
    asset: input.asset, kind: input.kind, title: input.title, description: input.description, photos, ...(input.spec ? { spec: input.spec } : {}),
    photosRoot: await mediaRootHex(photos, input.spec), updatedAt: Math.floor(Date.now() / 1000),
  };
}
