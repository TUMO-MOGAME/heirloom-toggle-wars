import "server-only";
/**
 * Family links (relationships and hidden flags) in Supabase (supabase/migrations/0006_family_links.sql), or in memory
 * when Supabase is not configured (then they last as long as the server instance; the browser that wrote them keeps
 * its own copy too, lib/tree/links.ts). The seeded devnet demo estate starts with default relationships; removing one
 * stores a tombstone (`removed`), so it stays removed.
 * Photos (plan.md §15.11) live beside them (supabase/migrations/0007_family_photos.sql, or memory): one 256×256 WebP
 * per person, at most 60 KB; removing one deletes the row.
 */
import { getSupabase } from "@/lib/supabase";
import { HttpError } from "@/lib/api/http";
import type { Base58 } from "@/lib/types";
import type { Relationship, RelationshipKind } from "../types";
import { defaultRelationships, type FamilyLinks } from "../links";
import type { FamilyPhotos, StoredPhoto } from "../photos";

interface Row { estate: string; id: string; kind: string; from_id: string; to_id: string; created_by: string; created_at: number; removed: boolean }

const mem = {
  links: new Map<string, Map<string, Row>>(),
  hidden: new Map<string, Map<Base58, boolean>>(),
  photos: new Map<string, Map<string, StoredPhoto>>(),
};
/** Photos kept per estate (a family is far smaller; this bounds memory and the GET). */
export const MAX_PHOTOS = 200;
export const MAX_PER_ESTATE = 500;
/**
 * The most photo data one GET returns, in characters: Vercel refuses a function response over 4.5 MB, and 200 photos
 * of 84,000 characters would be 16.8 MB. A write that would pass it is refused, so the GET never has to drop one.
 */
export const MAX_PHOTO_CHARS = 4_000_000;

/** Full: a new entry is refused. Nothing a family stored is ever pushed out to make room (plan §18.9 H5). */
const full = (what: string) => new HttpError(409, `This family's ${what} are full. Remove one first.`, "full");

function warn(what: string, err: { message: string } | null) {
  if (err) console.warn(`[family_links] ${what} failed: ${err.message}`);
}

const toRel = (r: Row): Relationship => ({ id: r.id, kind: r.kind as RelationshipKind, from: r.from_id, to: r.to_id, declaredBy: r.created_by, declaredAt: Number(r.created_at) });

/** Defaults, overridden by stored rows (a stored row with `removed` hides the default). */
function combine(estate: Base58, rows: Row[], hidden: Base58[]): FamilyLinks {
  const out = new Map(defaultRelationships(estate).map((r) => [r.id, r] as const));
  for (const r of rows) { if (r.removed) out.delete(r.id); else out.set(r.id, toRel(r)); }
  return { relationships: [...out.values()], hidden };
}

export async function getLinks(estate: Base58): Promise<FamilyLinks> {
  const sb = getSupabase();
  if (!sb) {
    const hidden = [...(mem.hidden.get(estate) ?? new Map()).entries()].filter(([, h]) => h).map(([w]) => w);
    return combine(estate, [...(mem.links.get(estate)?.values() ?? [])], hidden);
  }
  const [links, hidden] = await Promise.all([
    sb.from("family_links").select("*").eq("estate", estate).limit(MAX_PER_ESTATE),
    sb.from("family_hidden").select("wallet, hidden").eq("estate", estate).eq("hidden", true).limit(MAX_PER_ESTATE),
  ]);
  warn("getLinks", links.error);
  warn("getHidden", hidden.error);
  return combine(estate, (links.data ?? []) as Row[], ((hidden.data ?? []) as { wallet: string }[]).map((h) => h.wallet));
}

export async function putLink(estate: Base58, r: Relationship): Promise<void> {
  await write({ estate, id: r.id, kind: r.kind, from_id: r.from, to_id: r.to, created_by: r.declaredBy, created_at: r.declaredAt, removed: false });
}

export async function removeLink(estate: Base58, id: string, by: Base58, at: number, existing: Relationship): Promise<void> {
  await write({ estate, id, kind: existing.kind, from_id: existing.from, to_id: existing.to, created_by: by, created_at: at, removed: true });
}

async function write(row: Row): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const m = mem.links.get(row.estate) ?? new Map<string, Row>();
    if (!m.has(row.id) && m.size >= MAX_PER_ESTATE) throw full("relationships");
    m.set(row.id, row);
    mem.links.set(row.estate, m);
    return;
  }
  const { data: held } = await sb.from("family_links").select("id").eq("estate", row.estate).limit(MAX_PER_ESTATE);
  if ((held?.length ?? 0) >= MAX_PER_ESTATE && !held!.some((r) => r.id === row.id)) throw full("relationships");
  const { error } = await sb.from("family_links").upsert(row, { onConflict: "estate,id" });
  warn("write", error);
  if (error) throw new Error("The relationship could not be saved. Please try again.");
}

export async function setHiddenFlag(estate: Base58, wallet: Base58, hidden: boolean, at: number): Promise<void> {
  const sb = getSupabase();
  if (!sb) {
    const m = mem.hidden.get(estate) ?? new Map<Base58, boolean>();
    if (!m.has(wallet) && m.size >= MAX_PER_ESTATE) throw full("choices to hide");
    m.set(wallet, hidden);
    mem.hidden.set(estate, m);
    return;
  }
  const { error } = await sb.from("family_hidden").upsert({ estate, wallet, hidden, updated_at: at }, { onConflict: "estate,wallet" });
  warn("setHidden", error);
  if (error) throw new Error("Your choice could not be saved. Please try again.");
}

/* ---------- photos ---------- */

interface PhotoRow { estate: string; person: string; data: string; created_by: string; created_at: number }

async function storedPhotos(estate: Base58): Promise<Map<string, StoredPhoto>> {
  const sb = getSupabase();
  if (!sb) return mem.photos.get(estate) ?? new Map();
  const { data, error } = await sb.from("family_photos").select("person, data, created_by, created_at").eq("estate", estate)
    .order("created_at", { ascending: true }).limit(MAX_PHOTOS);
  warn("getPhotos", error);
  return new Map(((data ?? []) as Omit<PhotoRow, "estate">[]).map((r) => [r.person, { src: r.data, by: r.created_by, at: Number(r.created_at) }]));
}

/** The estate's photos, oldest first, never more than MAX_PHOTO_CHARS of image data (rows written before the cap). */
export async function getPhotos(estate: Base58): Promise<FamilyPhotos> {
  const photos: Record<string, StoredPhoto> = {};
  let chars = 0;
  for (const [person, p] of await storedPhotos(estate)) {
    if ((chars += p.src.length) > MAX_PHOTO_CHARS) break;
    photos[person] = p;
  }
  return { photos };
}

export async function putPhoto(estate: Base58, person: string, photo: StoredPhoto): Promise<void> {
  const held = await storedPhotos(estate);
  const others = [...held].filter(([p]) => p !== person);
  if ((!held.has(person) && held.size >= MAX_PHOTOS) || others.reduce((n, [, p]) => n + p.src.length, photo.src.length) > MAX_PHOTO_CHARS) {
    throw full("photos");
  }
  const sb = getSupabase();
  if (!sb) {
    const m = mem.photos.get(estate) ?? new Map<string, StoredPhoto>();
    m.set(person, photo);
    mem.photos.set(estate, m);
    return;
  }
  const row: PhotoRow = { estate, person, data: photo.src, created_by: photo.by, created_at: photo.at };
  const { error } = await sb.from("family_photos").upsert(row, { onConflict: "estate,person" });
  warn("putPhoto", error);
  if (error) throw new Error("The photo could not be saved. Please try again.");
}


/** Tests only. */
export function resetTreeMemory() { mem.links.clear(); mem.hidden.clear(); mem.photos.clear(); }
