/**
 * The tree at a year on the slider (plan.md §15.6): who is there, who has passed, which trust lines had started (and
 * ended), what was kept by then (grouped promises count only their events up to the end of that year) and how far
 * each asset had travelled. Pure; the snapshot is not changed.
 */
import type { KeptPromise, TreeAtYear, TreeSnapshot } from "./types";
import { countKept, yearOf } from "./derive";

/** The last second of `year` (UTC), unix seconds. */
export const endOfYear = (year: number) => Date.UTC(year + 1, 0, 1) / 1000 - 1;

function keptBy(k: KeptPromise, end: number): KeptPromise | null {
  if (k.firstTs > end) return null;
  if (k.kind === "guardianTerm") return k.lastTs > end ? { ...k, lastTs: end } : k;
  if (!k.tss?.length) return k;
  const tss = k.tss.filter((t) => t <= end);
  if (tss.length === 0) return null;
  if (tss.length === k.tss.length) return k;
  return { ...k, tss, count: tss.length, lastTs: tss[tss.length - 1] };
}

export function treeAtYear(t: TreeSnapshot, year: number): TreeAtYear {
  const end = endOfYear(year);
  const people = t.people
    .filter((p) => p.since <= year)
    .map((p) => {
      const gone = p.passed !== undefined && p.passed <= year;
      const { passed, ...rest } = p;
      return { ...rest, ...(gone ? { passed } : {}), alive: !gone };
    });
  const here = new Set(people.map((p) => p.id));
  const kept = t.kept.map((k) => keptBy(k, end)).filter((k): k is KeptPromise => !!k);
  const started = t.edges
    .filter((e) => e.fromTs <= end && here.has(e.from) && here.has(e.to))
    .map((e) => {
      const { toTs, ...rest } = e;
      return { ...rest, ...(toTs !== undefined && toTs <= end ? { toTs } : {}) };
    });
  return {
    year,
    people,
    relationships: t.relationships.filter((r) => here.has(r.from) && here.has(r.to)),
    edges: countKept(started, kept),
    kept,
    assets: t.assets
      .map((a) => ({ ...a, steps: a.steps.filter((s) => s.ts <= end) }))
      .filter((a) => a.steps.length > 0),
  };
}

/** The years the slider can show, oldest first. */
export function sliderYears(t: Pick<TreeSnapshot, "span">): number[] {
  const out: number[] = [];
  for (let y = t.span.from; y <= t.span.to; y++) out.push(y);
  return out;
}

export { yearOf };
