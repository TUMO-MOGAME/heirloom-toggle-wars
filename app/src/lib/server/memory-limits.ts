/**
 * Bounds for the in-memory stores used when Supabase is not configured (plan §18.9 M6). Memory stays bounded, and no
 * family's records are ever pushed out to make room for another's: past a store's limit a new family, or a new file,
 * is refused instead. Inside one family the store may let go of that family's own oldest record of least value.
 */
import { HttpError } from "../api/http";

export class StoreFull extends HttpError {
  constructor(what: string) {
    super(503, `This server's temporary storage for ${what} is full. Please try again later.`, "storage_full", 3_600);
  }
}

/** Throws StoreFull when a new `key` would make `map` larger than `max`. */
export function roomFor<K>(map: { has(k: K): boolean; size: number }, key: K, max: number, what: string): void {
  if (!map.has(key) && map.size >= max) throw new StoreFull(what);
}

/** Throws StoreFull when adding `bytes` under a new `key` would take the stored bytes past `max`. */
export function roomForBytes<K>(map: Map<K, { byteLength: number } | { bytes: { byteLength: number } }>, key: K, bytes: number, max: number, what: string): void {
  let held = 0;
  for (const [k, v] of map) if (k !== key) held += "bytes" in v ? v.bytes.byteLength : v.byteLength;
  if (held + bytes > max) throw new StoreFull(what);
}

/** Memory for files (photos, recordings) kept without Supabase, per store. */
export const MAX_MEMORY_FILE_BYTES = 256 * 1024 * 1024;
