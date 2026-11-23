/**
 * Trust Tree words (pure, tested): a person's facts at a year and the plain sentences for roles, kept promises and
 * assets. Never an amount or a score: only counts of promises and people, names and years.
 */
import type { TreeCopy } from "@/content/tree";
import type { Widen } from "@/lib/i18n/merge";
import type { AssetPath, AssetStep, KeptPromise, PersonId, TreeAtYear, TreePerson, TrustEdge } from "@/lib/tree/types";
import { yearOf } from "@/lib/tree/timeline";

export type Copy = Widen<TreeCopy>;
export type YearPerson = TreeAtYear["people"][number];

export const fill = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ""));

/** A child (under 18 at this year, and flagged minor) shows a first name only and no card details. */
export function isMinorAt(p: Pick<TreePerson, "minor" | "born">, year: number): boolean {
  return p.minor && (p.born === undefined || year - p.born < 18);
}

/** The name to show: "A family member" when hidden, the first name for a child, else the short form. */
export function shortLabel(copy: Copy, p: Pick<TreePerson, "hidden" | "short" | "name" | "minor" | "born"> | undefined, year: number): string {
  if (!p) return copy.person.hidden;
  if (p.hidden) return copy.person.hidden;
  if (isMinorAt(p, year)) return (p.short || p.name).split(" ")[0];
  return p.short || p.name;
}
export function fullLabel(copy: Copy, p: Pick<TreePerson, "hidden" | "short" | "name" | "minor" | "born">, year: number): string {
  if (p.hidden) return copy.person.hidden;
  if (isMinorAt(p, year)) return (p.short || p.name).split(" ")[0];
  return p.name || p.short;
}

export function yearsText(copy: Copy, from: number, to?: number): string {
  if (to === undefined) return fill(copy.since, { year: from });
  return from === to ? String(from) : fill(copy.person.years, { from, to });
}

/** "Lerato", "Lerato and Sipho", "Lerato, Sipho and Naledi". */
export function namesList(names: string[], and: string): string {
  const u = [...new Set(names)];
  if (u.length <= 1) return u[0] ?? "";
  return `${u.slice(0, -1).join(", ")} ${and} ${u[u.length - 1]}`;
}

/** Life years under a name: "1972–2034", "Born 2006", or "" when unknown. */
export function lifeText(copy: Copy, p: Pick<YearPerson, "born" | "passed" | "hidden" | "org">): string {
  if (p.hidden) return "";
  if (p.org) return copy.map.org;
  if (p.born !== undefined && p.passed !== undefined) return fill(copy.person.years, { from: p.born, to: p.passed });
  if (p.passed !== undefined) return fill(copy.person.passed, { year: p.passed });
  if (p.born !== undefined) return fill(copy.person.born, { year: p.born });
  return "";
}

export interface Facts {
  trustedBy: number;
  keptCount: number;
  roles: TrustEdge[];
  promises: KeptPromise[];
  received: { asset: AssetPath; step: AssetStep }[];
}

/** What the tree knows about one person by `at.year`. */
export function factsFor(at: TreeAtYear, id: PersonId): Facts {
  const roles = at.edges.filter((e) => e.to === id).sort((a, b) => a.fromTs - b.fromTs);
  const promises = at.kept.filter((k) => k.by === id).sort((a, b) => b.lastTs - a.lastTs);
  return {
    trustedBy: new Set(roles.map((e) => e.from)).size,
    keptCount: promises.filter((k) => k.kind !== "challengeUpheld").reduce((n, k) => n + k.count, 0),
    roles,
    promises,
    received: at.assets.flatMap((asset) => asset.steps.filter((s) => s.kind === "passedTo" && s.to === id).map((step) => ({ asset, step }))),
  };
}

export function trustedText(copy: Copy, n: number): string {
  return n === 1 ? copy.person.trusted.one : fill(copy.person.trusted.many, { n });
}
export function keptCountText(copy: Copy, n: number): string {
  return n === 0 ? copy.person.kept.none : n === 1 ? copy.person.kept.one : fill(copy.person.kept.many, { n });
}

/** "Trusted by 3 people · Kept 14 promises" (the trusted part is left out when nobody has trusted them yet). */
export function factsLine(copy: Copy, f: Pick<Facts, "trustedBy" | "keptCount">, sep = " · "): string {
  return [f.trustedBy > 0 ? trustedText(copy, f.trustedBy) : "", keptCountText(copy, f.keptCount)].filter(Boolean).join(sep);
}

type NameOf = (id: PersonId) => string;

/** "Trusted person in Thabo's plan, 2026–2034" (or "since 2026" while it lasts). */
export function roleTermText(copy: Copy, e: TrustEdge, nameOf: NameOf): string {
  return fill(copy.roleTerm, {
    role: copy.roles[e.role],
    owner: nameOf(e.from),
    years: yearsText(copy, yearOf(e.fromTs), e.toTs !== undefined ? yearOf(e.toTs) : undefined),
  });
}

/** One kept promise in plain words. */
export function keptText(copy: Copy, k: KeptPromise, nameOf: NameOf): string {
  const years = yearsText(copy, yearOf(k.firstTs), yearOf(k.lastTs));
  const forNames = namesList(k.for.map(nameOf), copy.and);
  const about = k.about ? nameOf(k.about) : "";
  const purpose = k.purpose && k.purpose in copy.purposes ? copy.purposes[k.purpose as keyof Copy["purposes"]] : copy.purposes.General;
  const count = (c: { one: string; many: string }) => fill(k.count === 1 ? c.one : c.many, { n: k.count, for: forNames, years });
  switch (k.kind) {
    case "confirmedPassing": {
      const base = fill(copy.kept.confirmedPassing, { about, years });
      const n = k.withOthers ?? 0;
      return n <= 0 ? base : `${base} (${n === 1 ? copy.kept.withOther : fill(copy.kept.withOthers, { n })})`;
    }
    case "approvedPayments": return count(copy.kept.approvedPayments);
    case "answeredRequests": return count(copy.kept.answeredRequests);
    case "planPaid": return fill(copy.kept.planPaid, { purpose, for: forNames, years });
    case "helpedHardship": return fill(copy.kept.helpedHardship, { for: forNames, years });
    case "guardianTerm": return fill(copy.kept.guardianTerm, { for: forNames, years });
    case "carriedOutFallback": return fill(copy.kept.carriedOutFallback, { about, years });
    case "raisedUpheldChallenge": return fill(copy.kept.raisedUpheldChallenge, { years });
    case "challengeUpheld": return fill(copy.kept.challengeUpheld, { years });
  }
}

/** "A car · 2017 Toyota Corolla". */
export function assetText(copy: Copy, a: Pick<AssetPath, "kind" | "title">): string {
  return `${copy.assetKinds[a.kind]} · ${a.title}`;
}

export function assetStepText(copy: Copy, s: AssetStep, owner: string, nameOf: NameOf): string {
  return fill(copy.assetSteps[s.kind], { owner, to: s.to ? nameOf(s.to) : "", year: yearOf(s.ts) });
}

/** Who holds an asset just before step `i` (its owner, then whoever it last passed to). */
export function holderBefore(a: AssetPath, i: number): PersonId {
  let holder = a.owner;
  for (let j = 0; j < i; j++) if (a.steps[j].kind === "passedTo" && a.steps[j].to) holder = a.steps[j].to!;
  return holder;
}
