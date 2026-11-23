/**
 * Trust Tree map layout (plan.md §15.6), pure so it can be tested: generations as rows (oldest at the top), siblings
 * by birth year under their parents, spouses side by side, people with no family line (advisers trusted by the
 * family) at the end of their row after a wider gap. Units are CSS pixels: the map measures its own width, so text
 * in the SVG keeps its real size.
 */
import type { PersonId, Relationship, TreePerson, TrustEdge } from "./types";

export interface NodePos {
  id: PersonId;
  x: number;
  y: number;
  generation: number;
  /** Not linked to anyone by a family relationship (an executor, an attorney…). */
  outside: boolean;
}

export interface TreeLayout {
  width: number;
  height: number;
  nodes: Map<PersonId, NodePos>;
  /** One per generation present, top to bottom. */
  rows: { generation: number; y: number }[];
  /** Where the "trusted outside the family" group starts in each row that has one (x of its first person). */
  outsideStart: Map<number, number>;
}

export interface LayoutOptions {
  width: number;
  /** Space between rows. */
  rowGap?: number;
  /** Preferred space between neighbours (shrinks to fit). */
  nodeGap?: number;
  /** Space above the first row and below the last. */
  padY?: number;
  /** Space on the left (the generation labels sit there) and on the right. */
  padLeft?: number;
  padRight?: number;
}

export const NODE_R = 26;

type Person = Pick<TreePerson, "id" | "born" | "generation">;

export function layoutTree(people: Person[], relationships: Relationship[], o: LayoutOptions): TreeLayout {
  const { width, rowGap = 156, nodeGap = 132, padY = 64, padLeft = 150, padRight = 48 } = o;
  const ids = new Set(people.map((p) => p.id));
  const rels = relationships.filter((r) => ids.has(r.from) && ids.has(r.to));
  const parents = new Map<PersonId, PersonId[]>();
  const spouses = new Map<PersonId, PersonId[]>();
  const linked = new Set<PersonId>();
  for (const r of rels) {
    linked.add(r.from); linked.add(r.to);
    if (r.kind === "parentOf") parents.set(r.to, [...(parents.get(r.to) ?? []), r.from]);
    if (r.kind === "spouseOf") {
      spouses.set(r.from, [...(spouses.get(r.from) ?? []), r.to]);
      spouses.set(r.to, [...(spouses.get(r.to) ?? []), r.from]);
    }
  }
  const born = (p: Person) => p.born ?? 9999;
  const generations = [...new Set(people.map((p) => p.generation))].sort((a, b) => a - b);
  const nodes = new Map<PersonId, NodePos>();
  const rows: TreeLayout["rows"] = [];
  const outsideStart = new Map<number, number>();

  generations.forEach((g, rowIndex) => {
    const y = padY + rowIndex * rowGap;
    rows.push({ generation: g, y });
    const inRow = people.filter((p) => p.generation === g);
    const family = inRow.filter((p) => linked.has(p.id));
    const outside = inRow.filter((p) => !linked.has(p.id)).sort((a, b) => born(a) - born(b) || a.id.localeCompare(b.id));
    const inRowIds = new Set(family.map((p) => p.id));

    // Where each person's parents sit (already placed, rows above); people without parents follow their spouse.
    const parentKey = (p: Person): number | null => {
      const xs = (parents.get(p.id) ?? []).map((id) => nodes.get(id)?.x).filter((x): x is number => x !== undefined);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    };
    const attached = new Set<PersonId>();
    const units: { lead: Person; with: Person[]; key: number | null }[] = [];
    const sorted = [...family].sort((a, b) => {
      const ka = parentKey(a), kb = parentKey(b);
      if (ka !== null && kb !== null && ka !== kb) return ka - kb;
      if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
      return born(a) - born(b) || a.id.localeCompare(b.id);
    });
    // Leads: people with parents on the tree first; a spouse without parents is attached beside them.
    for (const p of sorted) {
      if (attached.has(p.id)) continue;
      const partners = (spouses.get(p.id) ?? []).filter((s) => inRowIds.has(s) && !attached.has(s) && s !== p.id);
      const own = parentKey(p);
      const joiners = partners
        .map((s) => family.find((f) => f.id === s)!)
        .filter((s) => own !== null ? parentKey(s) === null : true);
      attached.add(p.id);
      joiners.forEach((s) => attached.add(s.id));
      units.push({ lead: p, with: joiners, key: own });
    }

    const order = units.flatMap((u) => [u.lead, ...u.with]);
    const all = [...order, ...outside];
    const gaps: number[] = [];
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1], b = all[i];
      const spouse = (spouses.get(a.id) ?? []).includes(b.id);
      const toOutside = i === order.length && outside.length > 0 && order.length > 0;
      gaps.push(toOutside ? 1.45 : spouse ? 0.82 : 1);
    }
    const units1 = gaps.reduce((s, x) => s + x, 0);
    const room = Math.max(0, width - padLeft - padRight);
    const gap = units1 > 0 ? Math.min(nodeGap, room / units1) : 0;
    const used = units1 * gap;
    let x = padLeft + (room - used) / 2;
    all.forEach((p, i) => {
      if (i > 0) x += gaps[i - 1] * gap;
      const isOutside = i >= order.length;
      if (isOutside && i === order.length) outsideStart.set(g, x);
      nodes.set(p.id, { id: p.id, x, y, generation: g, outside: isOutside });
    });
  });

  const height = rows.length ? rows[rows.length - 1].y + padY + 34 : padY * 2;
  return { width, height, nodes, rows, outsideStart };
}

/** Line thickness from the promises kept along a trust line (more promises, a thicker line; never a score). */
export function strokeFor(keptCount: number): number {
  return Math.round((1.5 + Math.min(4.5, Math.log2(1 + Math.max(0, keptCount)) * 1.05)) * 10) / 10;
}

export interface TrustCurve { id: string; d: string; edge: TrustEdge; /** For travelling along: the cubic's points. */ pts: [number, number][] }

/**
 * Curves for trust lines, from the person who trusted to the person trusted. Several lines between the same two
 * people fan out instead of lying on top of each other. Lines start and end at the circles' centres (circles are
 * drawn on top), which keeps every `d` the same shape so Motion can morph it as people move.
 */
export function trustCurves(edges: TrustEdge[], layout: TreeLayout): TrustCurve[] {
  const byPair = new Map<string, TrustEdge[]>();
  for (const e of edges) {
    if (!layout.nodes.has(e.from) || !layout.nodes.has(e.to) || e.from === e.to) continue;
    const k = `${e.from}>${e.to}`;
    byPair.set(k, [...(byPair.get(k) ?? []), e]);
  }
  const out: TrustCurve[] = [];
  for (const list of byPair.values()) {
    list.forEach((e, i) => {
      const a = layout.nodes.get(e.from)!, b = layout.nodes.get(e.to)!;
      const fan = (i - (list.length - 1) / 2) * 26;
      let pts: [number, number][];
      if (Math.abs(a.y - b.y) < 1) {
        // Same row: an arc over the top.
        const h = Math.min(98, 40 + Math.abs(b.x - a.x) * 0.12) + Math.abs(fan) * 0.6 + i * 8;
        const dx = (b.x - a.x) * 0.22;
        pts = [[a.x, a.y], [a.x + dx, a.y - h], [b.x - dx, b.y - h], [b.x, b.y]];
      } else {
        const dy = b.y - a.y;
        const side = b.x >= a.x ? 1 : -1;
        pts = [[a.x, a.y], [a.x + fan + side * 18, a.y + dy * 0.55], [b.x + fan - side * 10, b.y - dy * 0.5], [b.x, b.y]];
      }
      const r = (n: number) => Math.round(n * 10) / 10;
      const d = `M ${r(pts[0][0])} ${r(pts[0][1])} C ${r(pts[1][0])} ${r(pts[1][1])} ${r(pts[2][0])} ${r(pts[2][1])} ${r(pts[3][0])} ${r(pts[3][1])}`;
      out.push({ id: e.id, d, edge: e, pts });
    });
  }
  return out;
}

/** A point along a cubic Bézier at t (0..1), for an asset travelling along a line. */
export function pointOnCubic(pts: [number, number][], t: number): [number, number] {
  const u = 1 - t;
  const [p0, p1, p2, p3] = pts;
  const f = (i: 0 | 1) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  return [f(0), f(1)];
}

export interface FamilyLine { id: string; d: string; kind: "spouse" | "parent" | "sibling" }

/**
 * Quiet family lines: a short bar between spouses, and from each set of parents (their midpoint) an elbow down to
 * their children. Siblings are only drawn as a low arc when no parent links them on the tree.
 */
export function familyLines(relationships: Relationship[], layout: TreeLayout, r = NODE_R): FamilyLine[] {
  const pos = layout.nodes;
  const lines: FamilyLine[] = [];
  const rels = relationships.filter((x) => pos.has(x.from) && pos.has(x.to));
  for (const s of rels.filter((x) => x.kind === "spouseOf")) {
    const a = pos.get(s.from)!, b = pos.get(s.to)!;
    const [l, rr] = a.x < b.x ? [a, b] : [b, a];
    if (Math.abs(a.y - b.y) > 1) continue;
    lines.push({ id: s.id, kind: "spouse", d: `M ${l.x + r} ${l.y} L ${rr.x - r} ${rr.y}` });
  }
  // Children grouped by their set of parents.
  const parentsOf = new Map<PersonId, PersonId[]>();
  for (const p of rels.filter((x) => x.kind === "parentOf")) parentsOf.set(p.to, [...(parentsOf.get(p.to) ?? []), p.from]);
  const families = new Map<string, { parents: PersonId[]; children: PersonId[] }>();
  for (const [child, ps] of parentsOf) {
    const key = [...ps].sort().join("+");
    const f = families.get(key) ?? { parents: [...ps].sort(), children: [] };
    f.children.push(child);
    families.set(key, f);
  }
  for (const [key, f] of families) {
    const ps = f.parents.map((id) => pos.get(id)!);
    const kids = f.children.map((id) => pos.get(id)!).sort((a, b) => a.x - b.x);
    const top = Math.max(...ps.map((p) => p.y));
    const fromX = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    // A couple's line starts from the bar between them; a single parent's starts below their name and years.
    const fromY = ps.length > 1 ? top : top + r + 40;
    const kidY = Math.min(...kids.map((k) => k.y));
    const midY = kidY - r - Math.max(18, (kidY - r - fromY) * 0.42);
    const left = Math.min(fromX, kids[0].x), right = Math.max(fromX, kids[kids.length - 1].x);
    let d = `M ${round(fromX)} ${round(fromY)} L ${round(fromX)} ${round(midY)} M ${round(left)} ${round(midY)} L ${round(right)} ${round(midY)}`;
    for (const k of kids) d += ` M ${round(k.x)} ${round(midY)} L ${round(k.x)} ${round(k.y - r)}`;
    lines.push({ id: `fam-${key}`, kind: "parent", d });
  }
  const sharesParent = (a: PersonId, b: PersonId) => (parentsOf.get(a) ?? []).some((p) => (parentsOf.get(b) ?? []).includes(p));
  for (const s of rels.filter((x) => x.kind === "siblingOf")) {
    if (sharesParent(s.from, s.to)) continue;
    const a = pos.get(s.from)!, b = pos.get(s.to)!;
    const y = Math.max(a.y, b.y) + r + 6;
    lines.push({ id: s.id, kind: "sibling", d: `M ${round(a.x)} ${round(a.y + r)} Q ${round((a.x + b.x) / 2)} ${round(y + 22)} ${round(b.x)} ${round(b.y + r)}` });
  }
  return lines;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Initials for a circle: "Thabo Mokoena" → "TM", "Uncle Bongani Mokoena" → "BM", "Adv. Thandi Ndlovu" → "TN". */
export function initials(name: string): string {
  const parts = name.replace(/\s*\(.*\)$/, "").split(/\s+/).filter(Boolean)
    .filter((p, i, all) => !(i === 0 && all.length > 1 && /^(Adv\.?|Ms\.?|Mr\.?|Mrs\.?|Dr\.?|Prof\.?|Uncle|Aunt|Auntie|Cousin|Gogo|Mkhulu)$/i.test(p)));
  if (parts.length === 0) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}
