/**
 * Off-chain family links (plan.md §15.5): the relationships an owner declares and the hidden flags living adults set.
 * Shared by the chain service (browser), the /api/tree route (server) and their tests.
 *
 * - Writes are signed by the acting wallet (ed25519, like /api/asks): the message binds the action, estate, wallet,
 *   time and a SHA-256 of the canonical body. The server checks that a relationship write comes from the estate's
 *   owner (read from the chain) and that a hidden flag is the signer's own.
 * - Without Supabase the server keeps links in memory, so this device keeps its own copy too (localStorage), and
 *   the tree merges both: a link known on only one side is kept, a removal on this device is remembered.
 * - Ids are deterministic (`relationshipId`), so the same relationship declared twice is one relationship.
 */
import type { Base58 } from "../types";
import type { PersonId, Relationship, RelationshipKind } from "./types";
import { DEVNET_DEMO_ESTATE, DEVNET_DEMO_FAMILY, DEVNET_DEMO_META } from "../chain/demo-estate";

export const TREE_MAX_SKEW_MS = 5 * 60 * 1000;
export type TreeAction = "relate" | "unrelate" | "hide" | "photo";
export const RELATIONSHIP_KINDS: readonly RelationshipKind[] = ["parentOf", "spouseOf", "siblingOf"];
/** A wallet, or a local id for someone without one ("local:gogo-martha"). */
export const PERSON_ID = /^(local:[a-z0-9-]{1,40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** Same relationship, same id: spouses and siblings in either order are one relationship. */
export function relationshipId(kind: RelationshipKind, from: PersonId, to: PersonId): string {
  const [a, b] = kind === "parentOf" ? [from, to] : [from, to].sort();
  return `rel:${kind}:${a}:${b}`;
}

export function treeMessage(action: TreeAction, estate: Base58, wallet: Base58, ts: number, bodyHash: string): string {
  return `Heirloom family tree\naction:${action}\nestate:${estate}\nwallet:${wallet}\nts:${ts}\nbody:${bodyHash}`;
}

/** The signed part of each action, in a fixed key order. */
export function treeBody(
  b: { action: "relate"; kind: RelationshipKind; from: PersonId; to: PersonId } | { action: "unrelate"; id: string } | { action: "hide"; hidden: boolean }
    | { action: "photo"; person: PersonId; photo: string | null },
): string {
  if (b.action === "relate") return JSON.stringify({ kind: b.kind, from: b.from, to: b.to });
  if (b.action === "unrelate") return JSON.stringify({ id: b.id });
  if (b.action === "photo") return JSON.stringify({ person: b.person, photo: b.photo });
  return JSON.stringify({ hidden: b.hidden });
}

/** What GET /api/tree returns for an estate. */
export interface FamilyLinks {
  relationships: Relationship[];
  /** Wallets that chose to hide. */
  hidden: Base58[];
}

/* ---------- the seeded devnet demo estate's family (fictional people, public addresses) ---------- */

const SEEDED_AT = Date.UTC(2026, 10, 15, 10) / 1000;

/** Default relationships for an estate (only the seeded devnet demo estate has any). */
export function defaultRelationships(estate: Base58): Relationship[] {
  if (estate !== DEVNET_DEMO_ESTATE) return [];
  const by = DEVNET_DEMO_META.ownerWallet;
  return DEVNET_DEMO_FAMILY.relationships.map((r) => ({ id: relationshipId(r.kind, r.from, r.to), ...r, declaredBy: by, declaredAt: SEEDED_AT }));
}

/** Declared people for an estate's tree (full names and birth years; only the seeded devnet demo estate). */
export function defaultPeople(estate: Base58) {
  return estate === DEVNET_DEMO_ESTATE ? DEVNET_DEMO_FAMILY.people : [];
}

/* ---------- this device's copy ---------- */

const LOCAL_KEY = "heirloom.tree.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export interface LocalLinks {
  added: Relationship[];
  removed: string[];
  /** Hidden flags this device set, by wallet. */
  hidden: Record<Base58, boolean>;
}
const blank = (): LocalLinks => ({ added: [], removed: [], hidden: {} });

export function readLocalLinks(storage: Pick<Storage, "getItem"> | null, estate: Base58): LocalLinks {
  try {
    const all = JSON.parse(storage?.getItem(LOCAL_KEY) ?? "{}") as Record<string, LocalLinks>;
    const mine = all?.[estate];
    if (!mine || typeof mine !== "object") return blank();
    return {
      added: Array.isArray(mine.added) ? mine.added.filter((r) => r && typeof r.id === "string" && RELATIONSHIP_KINDS.includes(r.kind)) : [],
      removed: Array.isArray(mine.removed) ? mine.removed.filter((x) => typeof x === "string") : [],
      hidden: mine.hidden && typeof mine.hidden === "object" ? mine.hidden : {},
    };
  } catch { return blank(); }
}

export function writeLocalLinks(storage: Storage | null, estate: Base58, change: (l: LocalLinks) => LocalLinks): void {
  if (!storage) return;
  try {
    const all = JSON.parse(storage.getItem(LOCAL_KEY) ?? "{}") as Record<string, LocalLinks>;
    const next = change(readLocalLinks(storage, estate));
    storage.setItem(LOCAL_KEY, JSON.stringify({ ...all, [estate]: { ...next, added: next.added.slice(-200), removed: next.removed.slice(-200) } }));
  } catch { /* storage full or blocked: the server copy still counts */ }
}

/** Server links, plus what this device added, minus what this device removed; this device's own hidden flags win. */
export function mergeLinks(server: FamilyLinks, local: LocalLinks): FamilyLinks {
  const removed = new Set(local.removed);
  const rels = new Map<string, Relationship>();
  for (const r of [...server.relationships, ...local.added]) if (!removed.has(r.id) && !rels.has(r.id)) rels.set(r.id, r);
  const hidden = new Set(server.hidden);
  for (const [w, h] of Object.entries(local.hidden)) { if (h) hidden.add(w); else hidden.delete(w); }
  return { relationships: [...rels.values()], hidden: [...hidden] };
}
