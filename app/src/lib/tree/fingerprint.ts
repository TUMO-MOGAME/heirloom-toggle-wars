/**
 * The tree's fingerprint (plan.md §15.2): SHA-256 (hex) of the canonical tree, so a printed or shared tree can be
 * checked later. Only ids and wallets, relationships and trust edges go in; never names, years, hidden flags or kept
 * counts, so renaming someone or hiding a name does not change it. Canonical = every list sorted, keys sorted
 * (lib/agent/hash canonicalJson). Web Crypto, so it runs the same in the browser and in Node.
 */
import type { HexHash } from "../types";
import { hashJson } from "../agent/hash";
import type { Relationship, TreePerson, TreeSnapshot, TrustEdge } from "./types";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A relationship's identity: spouses and siblings in either order are the same relationship. */
function rel(r: Pick<Relationship, "kind" | "from" | "to">) {
  const [from, to] = r.kind === "parentOf" ? [r.from, r.to] : [r.from, r.to].sort(cmp);
  return { kind: r.kind, from, to };
}

export function canonicalTree(t: { estate: string; people: Pick<TreePerson, "id" | "wallets">[]; relationships: Pick<Relationship, "kind" | "from" | "to">[]; edges: Pick<TrustEdge, "from" | "to" | "role" | "estate" | "fromTs" | "toTs">[] }) {
  const line = (x: Record<string, unknown>) => JSON.stringify(x);
  const uniqSorted = <T extends Record<string, unknown>>(xs: T[]) => [...new Map(xs.map((x) => [line(x), x] as const)).entries()].sort((a, b) => cmp(a[0], b[0])).map(([, x]) => x);
  return {
    v: 1,
    estate: t.estate,
    people: uniqSorted(t.people.map((p) => ({ id: p.id, wallets: [...p.wallets].sort(cmp) }))),
    relationships: uniqSorted(t.relationships.map(rel)),
    edges: uniqSorted(t.edges.map((e) => ({ from: e.from, to: e.to, role: e.role, estate: e.estate, fromTs: e.fromTs, ...(e.toTs !== undefined ? { toTs: e.toTs } : {}) }))),
  };
}

export function treeFingerprint(t: Pick<TreeSnapshot, "estate" | "people" | "relationships" | "edges">): Promise<HexHash> {
  return hashJson(canonicalTree(t));
}
