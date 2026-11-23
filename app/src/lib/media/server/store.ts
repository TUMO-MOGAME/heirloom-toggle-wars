import "server-only";
/**
 * Asset photo storage (schema: supabase/migrations/0003_asset_photos.sql). Private bucket `asset-photos`; the
 * photo index lives in RLS-locked tables reached only with the service-role key. Without Supabase, an in-memory
 * store (demo and tests). Either way the browser gets short-lived signed URLs on our own origin
 * (/api/assets/photos/file?p&e&s, HMAC-SHA256, 1 hour), so the app's CSP (img-src 'self') needs no change and
 * the bucket stays private. Paths hold no names: "<sha256(estate) prefix>/<sha256(asset) prefix>/<sha256>.webp".
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSupabase } from "@/lib/supabase";
import { sha256Hex } from "@/lib/agent/hash";
import type { AssetKind, AssetPhoto } from "@/lib/guardians/types";
import type { AssetMediaView } from "../api";
import { mediaRootHex, type AssetSpec, type PhotoLabel } from "@/lib/assets/spec";
import { MAX_MEMORY_FILE_BYTES, roomForBytes } from "@/lib/server/memory-limits";

export const PHOTO_BUCKET = "asset-photos";
export const SIGNED_URL_SECS = 3600;

export interface PhotoRow { sha256: string; path: string; width: number; height: number; bytes: number; label?: PhotoLabel }
export interface MediaRow { estate: string; asset: string; kind: AssetKind; title: string; description: string; photos: PhotoRow[]; spec?: AssetSpec; updatedAt: number }

interface Mem { media: Map<string, MediaRow>; files: Map<string, Uint8Array> }
// On globalThis so every route module in this process shares one store.
const g = globalThis as typeof globalThis & { __heirloomAssetPhotos?: Mem };
const mem: Mem = (g.__heirloomAssetPhotos ??= { media: new Map(), files: new Map() });
const key = (estate: string, asset: string) => `${estate}:${asset}`;

export async function photoPath(estate: string, asset: string, sha256: string): Promise<string> {
  const [e, a] = await Promise.all([sha256Hex(`photos:${estate}`), sha256Hex(`photos:${asset}`)]);
  return `${e.slice(0, 24)}/${a.slice(0, 24)}/${sha256}.webp`;
}

function warn(what: string, err: { message: string } | null) { if (err) console.warn(`[asset-photos] ${what} failed: ${err.message}`); }

/* ---------- bytes ---------- */

export async function putPhoto(path: string, bytes: Uint8Array): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    roomForBytes(mem.files, path, bytes.byteLength, MAX_MEMORY_FILE_BYTES, "photos");
    mem.files.set(path, bytes);
    return;
  }
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: "image/webp", upsert: true });
  if (error) throw new Error(`Could not store the photo: ${error.message}`);
}

/** The bytes of a stored photo (memory or the private bucket), or null. */
export async function getPhoto(path: string): Promise<Uint8Array | null> {
  const sb = getSupabase();
  if (!sb) return mem.files.get(path) ?? null;
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/* ---------- signed URLs (same origin) ---------- */

// Key: derived from the service-role key when Supabase is set (stable across instances), else ASSET_PHOTO_URL_SECRET,
// else random per process (memory store only lives in one process anyway).
let urlKey: Buffer | null = null;
function signingKey(): Buffer {
  if (urlKey) return urlKey;
  const seed = process.env.ASSET_PHOTO_URL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  urlKey = seed ? createHmac("sha256", "heirloom:asset-photo-url").update(seed).digest() : randomBytes(32);
  return urlKey;
}
const mac = (path: string, exp: number) => createHmac("sha256", signingKey()).update(`${path}
${exp}`).digest("hex");

export function signedPhotoUrl(path: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SIGNED_URL_SECS;
  return `/api/assets/photos/file?p=${encodeURIComponent(path)}&e=${exp}&s=${mac(path, exp)}`;
}

export function verifyPhotoUrl(path: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(mac(path, exp), "hex"), Buffer.from(sig, "hex"));
}

async function removePhotos(paths: string[]): Promise<void> {
  if (!paths.length) return;
  const sb = getSupabase();
  if (!sb) { paths.forEach((p) => mem.files.delete(p)); return; }
  warn("remove", (await sb.storage.from(PHOTO_BUCKET).remove(paths)).error);
}

/* ---------- index ---------- */

export async function getMedia(estate: string, asset: string): Promise<MediaRow | null> {
  return (await listMedia(estate)).find((m) => m.asset === asset) ?? null;
}

export async function listMedia(estate: string): Promise<MediaRow[]> {
  const sb = getSupabase();
  if (!sb) return [...mem.media.values()].filter((m) => m.estate === estate);
  const [{ data: media, error: e1 }, { data: photos, error: e2 }] = await Promise.all([
    sb.from("asset_media").select("*").eq("estate", estate),
    sb.from("asset_photos").select("*").eq("estate", estate).order("position", { ascending: true }),
  ]);
  warn("listMedia", e1); warn("listPhotos", e2);
  return (media ?? []).map((m) => ({
    estate: m.estate, asset: m.asset, kind: m.kind as AssetKind, title: m.title, description: m.description ?? "", updatedAt: Math.floor(new Date(m.updated_at).getTime() / 1000),
    ...(m.spec ? { spec: m.spec as AssetSpec } : {}),
    photos: (photos ?? []).filter((p) => p.asset === m.asset).map((p) => ({
      sha256: p.sha256, path: p.path, width: p.width, height: p.height, bytes: p.bytes, ...(p.label ? { label: p.label as PhotoLabel } : {}),
    })),
  }));
}

/** Replaces an asset's photo index with `row` and deletes stored files that are no longer in the set. */
export async function saveMedia(row: MediaRow, previous: MediaRow | null): Promise<void> {
  const keep = new Set(row.photos.map((p) => p.path));
  const orphans = (previous?.photos ?? []).map((p) => p.path).filter((p) => !keep.has(p));
  const sb = getSupabase();
  if (!sb) {
    mem.media.set(key(row.estate, row.asset), structuredClone(row));
    await removePhotos(orphans);
    return;
  }
  const { error } = await sb.from("asset_media").upsert({
    estate: row.estate, asset: row.asset, kind: row.kind, title: row.title, description: row.description, spec: row.spec ?? null,
    photos_root: await mediaRootHex(row.photos, row.spec), updated_at: new Date(row.updatedAt * 1000).toISOString(),
  });
  if (error) throw new Error(`Could not save the photos: ${error.message}`);
  warn("clearPhotos", (await sb.from("asset_photos").delete().eq("estate", row.estate).eq("asset", row.asset)).error);
  if (row.photos.length) {
    const { error: e2 } = await sb.from("asset_photos").insert(row.photos.map((p, i) => ({
      estate: row.estate, asset: row.asset, position: i, sha256: p.sha256, path: p.path, width: p.width, height: p.height, bytes: p.bytes, label: p.label ?? null,
    })));
    if (e2) throw new Error(`Could not save the photos: ${e2.message}`);
  }
  await removePhotos(orphans);
}

/* ---------- public view ---------- */

export async function toInfo(row: MediaRow): Promise<AssetMediaView> {
  const photos: AssetPhoto[] = row.photos.map((p) => ({ sha256: p.sha256, url: signedPhotoUrl(p.path), width: p.width, height: p.height, bytes: p.bytes, ...(p.label ? { label: p.label } : {}) }));
  return {
    asset: row.asset, kind: row.kind, title: row.title, description: row.description, photos, ...(row.spec ? { spec: row.spec } : {}),
    photosRoot: await mediaRootHex(photos, row.spec), updatedAt: row.updatedAt,
  };
}

/** Tests only. */
export function resetMemPhotos(): void { mem.media.clear(); mem.files.clear(); }
