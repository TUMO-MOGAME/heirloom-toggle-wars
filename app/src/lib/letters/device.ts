/**
 * What this device keeps of letters (plan.md §16.5):
 *  - the author's own letters (`heirloom.letters.v1`, per estate), so an owner without a server store (503) or
 *    offline still sees and edits them; merged with the server's by version (higher wins, a tombstone wins a tie);
 *  - for recipients, only the ids of letters they have seen (`heirloom.letters.seen.v1`), never the text: the
 *    "you have a letter" card shows until the letter has been read on this device.
 */
import type { Base58 } from "../types";
import type { Letter } from "./types";
import { LETTER_ID } from "./types";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const KEY = "heirloom.letters.v1";
const SEEN = "heirloom.letters.seen.v1";

const isLetter = (x: unknown): x is Letter => {
  const l = x as Letter;
  return !!l && typeof l === "object" && typeof l.id === "string" && LETTER_ID.test(l.id) && typeof l.version === "number"
    && typeof l.from === "string" && !!l.to && !!l.opens && typeof l.text === "string";
};

export function readDeviceLetters(storage: Pick<Storage, "getItem"> | null, estate: Base58, author: Base58): Letter[] {
  try {
    const all = JSON.parse(storage?.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const mine = all?.[estate];
    return Array.isArray(mine) ? mine.filter(isLetter).filter((l) => l.from === author) : [];
  } catch { return []; }
}

/** Keeps (or replaces) the author's own letter on this device. Returns false when storage is full or blocked. */
export function keepOnDevice(storage: Storage | null, letter: Letter): boolean {
  if (!storage) return false;
  try {
    const all = JSON.parse(storage.getItem(KEY) ?? "{}") as Record<string, Letter[]>;
    const list = (Array.isArray(all[letter.estate]) ? all[letter.estate] : []).filter((l) => l.id !== letter.id);
    storage.setItem(KEY, JSON.stringify({ ...all, [letter.estate]: [...list, letter].slice(-120) }));
    return true;
  } catch { return false; }
}

/** One letter by id: the higher version wins; at the same version a tombstone wins. */
export function newer(a: Letter, b: Letter): Letter {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return b.deleted ? b : a;
}

export function mergeLetters<T extends Letter>(server: T[], device: Letter[], view: (l: Letter) => T): T[] {
  const out = new Map<string, T>(server.map((l) => [l.id, l]));
  for (const l of device) {
    const s = out.get(l.id);
    if (!s) out.set(l.id, view(l));
    else if (newer(s, l) !== s) out.set(l.id, view(l));
  }
  return [...out.values()];
}

/* ---------- recipients: seen ids only ---------- */

export function seenIds(storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const list = JSON.parse(storage?.getItem(SEEN) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);
  } catch { return new Set(); }
}

export function markSeen(storage: Storage | null, ids: string[]): void {
  if (!storage || !ids.length) return;
  try {
    const set = seenIds(storage);
    ids.forEach((i) => set.add(i));
    storage.setItem(SEEN, JSON.stringify([...set].slice(-500)));
  } catch { /* storage blocked: the card shows again next time */ }
}

export const browserStorage = (): Storage | null => {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
};
