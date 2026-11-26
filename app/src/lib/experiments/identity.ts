import { experiments } from "@/content/experiments";

/**
 * The visitor's random anonymous id (plan §2): a UUID made on this device and kept in localStorage, so a reload or
 * another page gets the same id and the same version. Never a name, wallet, email or IP. When storage is blocked
 * (private window, cleared site data) the id lives in memory for this visit only.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memoryId: string | null = null;

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The id for this device, made on first use. `store` is injectable for tests. */
export function anonId(store: KeyValueStore | null = defaultStore()): string {
  try {
    const saved = store?.getItem(experiments.storageKey);
    if (saved && UUID.test(saved)) return saved;
  } catch {
    // Storage read refused: fall through to the in-memory id.
  }
  const id = memoryId && UUID.test(memoryId) ? memoryId : randomUuid();
  memoryId = id;
  try {
    store?.setItem(experiments.storageKey, id);
  } catch {
    // Storage full or blocked: the in-memory id serves this visit.
  }
  return id;
}

export const isAnonId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

/** Tests only. */
export function resetMemoryId() {
  memoryId = null;
}
