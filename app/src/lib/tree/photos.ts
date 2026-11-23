/**
 * Photos on the Trust Tree (plan.md §15.11). Shared by the mock and chain services, the /api/tree/photo route and
 * the UI, so every side applies the same rules.
 *
 * - Never on-chain, and not in the fingerprint (lib/tree/fingerprint.ts hashes ids and wallets only).
 * - Consent (`photoConsent`): a living adult adds, replaces or removes only their own photo. The estate owner decides
 *   for a child, for someone who has passed, for someone without a wallet (local: ids, e.g. grandparents) and for an
 *   organisation (a logo). A hidden person never shows a photo and nobody may set one for them.
 * - Format (`checkPhoto`): a 256×256 WebP made in the browser (lib/tree/photo-image.ts; re-encoding on a canvas
 *   strips EXIF and location), sent as a data URL, at most 60 KB of image data.
 * - Without a server store this device keeps its own copy (localStorage), like the family links (lib/tree/links.ts).
 */
import type { Base58 } from "../types";
import type { PersonId, TreePerson } from "./types";

/** The largest stored photo, in bytes of WebP data. */
export const PHOTO_MAX_BYTES = 60 * 1024;
/** The side of the square photo, in pixels. */
export const PHOTO_SIZE = 256;
/** Request bodies carrying a photo: the base64 data URL (4/3 of the bytes) and the signed fields. */
export const PHOTO_MAX_BODY = Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 2_000;

const WEBP_URL = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/;

/** A photo as stored: the image, who added it and when. */
export interface StoredPhoto {
  /** data:image/webp;base64,… (or, in the demo, a bundled face under /demo/people/ or a drawn logo). */
  src: string;
  /** The wallet that added it. */
  by: Base58;
  /** Unix seconds. */
  at: number;
}

export type PhotoSubject = Pick<TreePerson, "id" | "wallets" | "born" | "passed" | "hidden"> & { org?: boolean };

/**
 * Who may set or remove this person's photo: "own" (a living adult, themselves), "owner" (the estate owner, for a
 * child, someone who has passed, someone without a wallet or an organisation) or null (nobody here).
 */
export function photoConsent(subject: PhotoSubject, actor: Base58 | null, actorIsOwner: boolean, today: number): "own" | "owner" | null {
  if (!actor || subject.hidden) return null;
  const passed = subject.passed !== undefined && subject.passed <= today;
  const minor = subject.born !== undefined && today - subject.born < 18;
  const noWallet = subject.wallets.length === 0 || subject.id.startsWith("local:");
  if (!subject.org && !passed && !minor && !noWallet) {
    // A living adult: their own photo only, the owner included.
    return subject.wallets.includes(actor) || subject.id === actor ? "own" : null;
  }
  return actorIsOwner ? "owner" : null;
}

/** Why a photo is refused, or null when it is a WebP data URL of at most 60 KB. */
export function checkPhoto(src: string): "type" | "size" | null {
  if (src.length > PHOTO_MAX_BODY) return "size";
  const m = WEBP_URL.exec(src);
  if (!m) return "type";
  const b64 = m[1];
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes > PHOTO_MAX_BYTES) return "size";
  // RIFF....WEBP: the first 12 bytes are 16 base64 characters.
  const head = atobSafe(b64.slice(0, 16));
  if (!head || head.slice(0, 4) !== "RIFF" || head.slice(8, 12) !== "WEBP") return "type";
  return null;
}

function atobSafe(s: string): string | null {
  try { return atob(s); } catch { return null; }
}

/** Only photos the tree may show: a hidden person never shows one. Used by derive. */
export function visiblePhoto(p: Pick<TreePerson, "hidden">, photo: StoredPhoto | null | undefined): StoredPhoto | null {
  return !p.hidden && photo && typeof photo.src === "string" && photo.src ? photo : null;
}

/** What GET /api/tree/photo returns for an estate. */
export interface FamilyPhotos { photos: Record<PersonId, StoredPhoto> }

/* ---------- this device's copy ---------- */

const LOCAL_KEY = "heirloom.tree.photos.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
/** By person: a photo this device set, or null for one it removed. */
export type LocalPhotos = Record<PersonId, StoredPhoto | null>;

const isPhoto = (x: unknown): x is StoredPhoto => !!x && typeof x === "object" && typeof (x as StoredPhoto).src === "string" && typeof (x as StoredPhoto).by === "string" && typeof (x as StoredPhoto).at === "number";

export function readLocalPhotos(storage: Pick<Storage, "getItem"> | null, estate: Base58): LocalPhotos {
  try {
    const all = JSON.parse(storage?.getItem(LOCAL_KEY) ?? "{}") as Record<string, LocalPhotos>;
    const mine = all?.[estate];
    if (!mine || typeof mine !== "object") return {};
    return Object.fromEntries(Object.entries(mine).filter(([, v]) => v === null || isPhoto(v)));
  } catch { return {}; }
}

/** Changes this device's copy for an estate. Returns false when the device could not keep it (storage full or blocked). */
export function writeLocalPhotos(storage: Storage | null, estate: Base58, change: (l: LocalPhotos) => LocalPhotos): boolean {
  if (!storage) return false;
  try {
    const all = JSON.parse(storage.getItem(LOCAL_KEY) ?? "{}") as Record<string, LocalPhotos>;
    storage.setItem(LOCAL_KEY, JSON.stringify({ ...all, [estate]: change(readLocalPhotos(storage, estate)) }));
    return true;
  } catch { return false; }
}

/** Server photos, with this device's changes on top (a removal here hides the server's copy). */
export function mergePhotos(server: Record<PersonId, StoredPhoto>, local: LocalPhotos): Record<PersonId, StoredPhoto> {
  const out: Record<PersonId, StoredPhoto> = { ...server };
  for (const [id, p] of Object.entries(local)) { if (p) out[id] = p; else delete out[id]; }
  return out;
}
