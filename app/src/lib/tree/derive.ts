/**
 * Builds a TreeSnapshot (plan.md §15.3) from one or more estates, the off-chain relationships, hidden flags and
 * generation links. Pure apart from the fingerprint (Web Crypto). No amounts ever: events carry none, and
 * `assertNoAmounts` (tests) walks the result.
 *
 * - People: each estate's owner and everyone with a role (trusted people, beneficiaries, seat holders, backups,
 *   monitors, fallback recipients, heirs), everyone in a relationship, and declared people (e.g. grandparents with no
 *   wallet). Names from the declared list, else the estate's name book (lib/people.ts), else the short address.
 *   A hidden living adult keeps their edges but loses name and years; a minor shows the first name only.
 * - Trust edges: from roles, timed by the estate's history (role changes close an edge).
 * - Kept promises and asset paths: lib/tree/promises.ts.
 * - Generations: rows from "parentOf" (spouses and siblings share a row); people outside the family sit on the row of
 *   the owner who trusted them.
 */
import type { Base58 } from "../types";
import type { EstateSnapshot } from "../service/types";
import { nameBook, type NameSources } from "../people";
import { fullName, shortName } from "../names";
import { shortAddress } from "../format";
import type { GenerationLink, KeptPromise, PersonId, Relationship, TreePerson, TreeSnapshot, TrustEdge, TrustRole } from "./types";
import { mergeEvents, snapshotFacts, type TreeEvent, type TreeEventKind } from "./events";
import { assetPaths, keptPromises } from "./promises";
import { treeFingerprint } from "./fingerprint";
import { visiblePhoto, type StoredPhoto } from "./photos";

/** Someone the family declared off-chain: a person without a wallet, or years and a full name for a wallet. */
export interface DeclaredPerson {
  id: PersonId;
  name?: string;
  wallets?: Base58[];
  born?: number;
  passed?: number;
  /** An organisation (e.g. a charity), not a person. */
  org?: boolean;
}

export interface TreeEstateInput {
  estate: Base58;
  owner: Base58;
  /** The estate as the app reads it (roles, names); absent for an estate known only from facts (the demo's future plans). */
  snapshot?: EstateSnapshot;
  /** Decoded chain history (lib/tree/events treeEventsFromChain), oldest or newest first. */
  history?: TreeEvent[];
  /** True when older history could not be loaded: snapshot facts then fill the gaps. */
  partial?: boolean;
  /** More facts for this estate (the demo story's imagined future). */
  extra?: TreeEvent[];
}

export interface DeriveInput {
  /** The estate the tree is opened from. */
  estate: Base58;
  mode: "mock" | "chain";
  estates: TreeEstateInput[];
  relationships: Relationship[];
  /** People who chose to hide (only honoured for living adults). */
  hidden: PersonId[];
  generations: GenerationLink[];
  people?: DeclaredPerson[];
  /** The current year ("today" on the slider). */
  today: number;
  /** Fixed slider span (the demo story's 1990–2086); otherwise from the people and events. */
  span?: { from?: number; to?: number };
  /** Names this device knows (lib/people NameSources). */
  nameSources?: NameSources;
  partial?: boolean;
  /** Photos by person (off-chain; never in the fingerprint). A hidden person's photo is dropped here. */
  photos?: Record<PersonId, StoredPhoto>;
}

export const yearOf = (ts: number) => new Date(ts * 1000).getUTCFullYear();

/** Facts the snapshot always adds, even next to a complete chain history (the chain has no event for these). */
const ROLE_FACTS = new Set<TreeEventKind>(["EstateCreated", "VerifiersSet", "BeneficiaryAdded", "RuleSet", "ClaimSubmitted", "HardshipSubmitted", "AssetRegistered"]);

/** One estate's facts: chain history first, then what the snapshot adds, then the story's extra facts. */
export function estateEvents(input: TreeEstateInput): TreeEvent[] {
  const history = input.history ?? [];
  const facts = input.snapshot ? snapshotFacts(input.snapshot, history) : [];
  const complete = history.length > 0 && !input.partial;
  return mergeEvents(history, complete ? facts.filter((f) => ROLE_FACTS.has(f.kind)) : facts, input.extra ?? []);
}

/* ---------- edges ---------- */

/** Trust edges from the estate's roles, each closed when the role ends (a successor took the seat, a new config dropped them). */
export function deriveEdges(events: TreeEvent[], owners: Record<Base58, PersonId>): TrustEdge[] {
  const edges: TrustEdge[] = [];
  const open = new Map<string, TrustEdge>();
  const start = (estate: Base58, role: TrustRole, to: PersonId, ts: number, slot = "") => {
    const from = owners[estate];
    if (!from || !to || to === from) return;
    const k = `${estate}|${role}|${slot}|${to}`;
    if (open.has(k)) return;
    const e: TrustEdge = { id: `edge:${estate}:${role}:${slot}:${to}:${ts}`, from, to, role, estate, fromTs: ts, keptCount: 0 };
    open.set(k, e);
    edges.push(e);
  };
  const end = (estate: Base58, role: TrustRole, to: PersonId, ts: number, slot = "") => {
    const k = `${estate}|${role}|${slot}|${to}`;
    const e = open.get(k);
    if (!e) return;
    e.toTs = ts;
    open.delete(k);
  };
  /** Replaces a set-valued role (backups, monitors, fallback order): people dropped from the set end, new ones start. */
  const setRole = (estate: Base58, role: TrustRole, slot: string, people: Base58[], ts: number) => {
    const prefix = `${estate}|${role}|${slot}|`;
    for (const k of [...open.keys()]) if (k.startsWith(prefix) && !people.includes(k.slice(prefix.length))) end(estate, role, k.slice(prefix.length), ts, slot);
    for (const p of people) start(estate, role, p, ts, slot);
  };
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    switch (e.kind) {
      case "VerifiersSet": e.verifiers.forEach((v, i) => start(e.estate, "trustedPerson", v, e.ts, String(i))); break;
      case "BeneficiaryAdded": start(e.estate, "beneficiary", e.wallet, e.ts); break;
      case "SeatConfigured":
        setRole(e.estate, "successor", String(e.seat), e.backups, e.ts);
        setRole(e.estate, "monitor", String(e.seat), e.monitors, e.ts);
        break;
      case "SuccessionFinalized":
        end(e.estate, "trustedPerson", e.previous, e.ts, String(e.seat));
        end(e.estate, "guardian", e.previous, e.ts, String(e.seat));
        end(e.estate, "successor", e.next, e.ts, String(e.seat));
        start(e.estate, "guardian", e.next, e.ts, String(e.seat));
        break;
      case "SeatVacated":
        end(e.estate, "trustedPerson", e.previous, e.ts, String(e.seat));
        end(e.estate, "guardian", e.previous, e.ts, String(e.seat));
        break;
      case "FallbackSet": setRole(e.estate, "fallback", "", e.recipients, e.ts); break;
      case "AssetPassed": start(e.estate, "heir", e.to, e.ts, e.asset); break;
      default: break;
    }
  }
  return edges;
}

const PREFER: Partial<Record<KeptPromise["kind"], TrustRole[]>> = {
  confirmedPassing: ["trustedPerson", "guardian", "successor", "monitor"],
  approvedPayments: ["guardian", "trustedPerson", "successor", "monitor"],
  helpedHardship: ["trustedPerson", "guardian", "successor", "monitor"],
  guardianTerm: ["guardian", "trustedPerson", "successor"],
  raisedUpheldChallenge: ["monitor", "trustedPerson", "guardian", "successor", "beneficiary", "fallback", "heir"],
  planPaid: ["beneficiary", "heir", "fallback"],
  answeredRequests: ["beneficiary", "heir", "fallback"],
  carriedOutFallback: ["fallback", "beneficiary", "heir"],
};

/** The edge a kept promise thickens: owner → keeper, or (for what the owner's plan did) owner → the person it was for. */
export function edgeForPromise(k: KeptPromise, edges: TrustEdge[]): TrustEdge | null {
  const roles = PREFER[k.kind];
  if (!roles) return null; // the negative fact never thickens a line
  const inEstate = edges.filter((e) => e.estate === k.estate);
  const owner = inEstate[0]?.from;
  const target = owner && k.by === owner ? k.for[0] : k.by;
  if (!target) return null;
  const mine = inEstate.filter((e) => e.to === target);
  const active = (e: TrustEdge) => e.fromTs <= k.firstTs && (e.toTs === undefined || e.toTs >= k.firstTs);
  for (const r of roles) {
    const hit = mine.find((e) => e.role === r && active(e)) ?? mine.find((e) => e.role === r);
    if (hit) return hit;
  }
  return null;
}

/** Sets each edge's keptCount from the promises (a new array; edges are copied). */
export function countKept(edges: TrustEdge[], kept: KeptPromise[]): TrustEdge[] {
  const out = edges.map((e) => ({ ...e, keptCount: 0 }));
  for (const k of kept) {
    const e = edgeForPromise(k, out);
    if (e) e.keptCount += k.count;
  }
  return out;
}

/* ---------- generations ---------- */

/** Rows from relationships (0 = oldest), then people outside the family on the row of the owner who trusted them. */
export function generationsOf(ids: PersonId[], relationships: Relationship[], edges: TrustEdge[]): Map<PersonId, number> {
  const g = new Map<PersonId, number>();
  const inFamily = new Set(relationships.flatMap((r) => [r.from, r.to]));
  for (const id of ids) if (inFamily.has(id)) g.set(id, 0);
  const bump = (id: PersonId, v: number) => { if ((g.get(id) ?? -Infinity) < v) { g.set(id, v); return true; } return false; };
  for (let i = 0; i <= ids.length + 2; i++) {
    let changed = false;
    for (const r of relationships) {
      const a = g.get(r.from) ?? 0, b = g.get(r.to) ?? 0;
      if (r.kind === "parentOf") {
        changed = bump(r.to, a + 1) || changed;
        changed = bump(r.from, b - 1) || changed;
      } else {
        changed = bump(r.from, b) || changed;
        changed = bump(r.to, a) || changed;
      }
    }
    if (!changed) break;
  }
  // Outside the family: the row of whoever trusted them (repeat, so a chain of owners settles).
  for (let i = 0; i < 3; i++) {
    for (const e of edges) if (!g.has(e.to) && g.has(e.from)) g.set(e.to, g.get(e.from)!);
    for (const e of edges) if (!g.has(e.from) && g.has(e.to)) g.set(e.from, g.get(e.to)!);
  }
  for (const id of ids) if (!g.has(id)) g.set(id, 0);
  const min = Math.min(...g.values());
  for (const [k, v] of g) g.set(k, v - (Number.isFinite(min) ? min : 0));
  return g;
}

/* ---------- people ---------- */

const ROLE_WALLETS = (e: TreeEvent): Base58[] => {
  switch (e.kind) {
    case "EstateCreated": return [e.owner];
    case "VerifiersSet": return e.verifiers;
    case "BeneficiaryAdded": return [e.wallet];
    case "SeatConfigured": return [...(e.holder ? [e.holder] : []), ...e.backups, ...e.monitors];
    case "SuccessionFinalized": return [e.previous, e.next];
    case "SeatVacated": return [e.previous];
    case "FallbackSet": return e.recipients;
    case "FallbackExecuted": return [e.recipient];
    case "AssetPassed": return [e.to];
    case "DisputeRaised": case "ObjectionRaised": return [e.by];
    default: return [];
  }
};

const firstName = (name: string) => fullName(name).split(/\s+/)[0] ?? "";

/** The tree, without the fingerprint (sync; see `deriveTree`). */
export function deriveTreeBody(input: DeriveInput): Omit<TreeSnapshot, "fingerprint"> {
  const owners: Record<Base58, PersonId> = {};
  const perEstate = input.estates.map((x) => {
    const events = estateEvents(x);
    const created = events.find((e): e is Extract<TreeEvent, { kind: "EstateCreated" }> => e.kind === "EstateCreated");
    owners[x.estate] = created?.owner ?? x.owner;
    return { input: x, events };
  });
  const events = perEstate.flatMap((p) => p.events).sort((a, b) => a.ts - b.ts);
  const ctx = { owners };

  // People and their wallets.
  const declared = new Map((input.people ?? []).map((p) => [p.id, p] as const));
  const ids = new Set<PersonId>();
  for (const e of events) for (const w of ROLE_WALLETS(e)) if (w) ids.add(w);
  for (const r of input.relationships) { ids.add(r.from); ids.add(r.to); }
  for (const l of input.generations) ids.add(l.person);
  for (const p of declared.keys()) ids.add(p);
  for (const o of Object.values(owners)) ids.add(o);

  // Names: declared, then each estate's name book (the opened estate first), then this device.
  const books = [...perEstate].sort((a, b) => Number(b.input.estate === input.estate) - Number(a.input.estate === input.estate))
    .map((p) => nameBook(p.input.snapshot ?? null, input.nameSources));
  const known = (id: PersonId) => {
    for (const b of books) { const n = b.get(id); if (n) return n; }
    return null;
  };

  // Passing years: an owner's from the unlock; a seat holder's from the confirmed passing that moved their seat on.
  const passedYear = new Map<PersonId, number>();
  for (const [estate, owner] of Object.entries(owners)) {
    const u = events.find((e) => e.kind === "EstateUnlocked" && e.estate === estate);
    if (u) passedYear.set(owner, yearOf(u.ts));
  }
  const confirmedSeat = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "SeatDeathConfirmed") confirmedSeat.set(`${e.estate}:${e.seat}`, e.ts);
    else if (e.kind === "SeatDeathVetoed") confirmedSeat.delete(`${e.estate}:${e.seat}`);
    else if ((e.kind === "SuccessionFinalized" || e.kind === "SeatVacated") && confirmedSeat.has(`${e.estate}:${e.seat}`)) {
      if (!passedYear.has(e.previous)) passedYear.set(e.previous, yearOf(confirmedSeat.get(`${e.estate}:${e.seat}`)!));
      confirmedSeat.delete(`${e.estate}:${e.seat}`);
    }
  }

  const edgesRaw = deriveEdges(events, owners);
  const kept = keptPromises(events, ctx);
  const edges = countKept(edgesRaw, kept);
  const idList = [...ids].sort();
  const gens = generationsOf(idList, input.relationships, edges);
  const hidden = new Set(input.hidden);
  const ownsEstate = new Map<PersonId, Base58>();
  for (const [estate, owner] of Object.entries(owners)) ownsEstate.set(owner, estate);
  for (const l of input.generations) if (!ownsEstate.has(l.person)) ownsEstate.set(l.person, l.childEstate);

  // When each person first appears: born, else their first role, relationship or kept promise, else today.
  const firstSeen = new Map<PersonId, number>();
  const see = (id: PersonId, ts: number) => { const y = yearOf(ts); if (!firstSeen.has(id) || firstSeen.get(id)! > y) firstSeen.set(id, y); };
  for (const e of edges) { see(e.from, e.fromTs); see(e.to, e.fromTs); }
  for (const k of kept) see(k.by, k.firstTs);
  for (const r of input.relationships) { see(r.from, r.declaredAt); see(r.to, r.declaredAt); }

  // Charities in a fallback plan are organisations, not people.
  const orgs = new Set<PersonId>(perEstate.flatMap((p) => (p.input.snapshot?.guardians?.fallback.recipients ?? []).filter((r) => r.kind === "charity").map((r) => r.wallet)));

  const people: TreePerson[] = idList.map((id) => {
    const d = declared.get(id);
    const book = known(id);
    const wallets = d?.wallets ?? (id.startsWith("local:") ? [] : [id]);
    let name = d?.name ?? book?.name ?? (id.startsWith("local:") ? "" : shortAddress(id));
    let short = d?.name ? shortName(d.name) || d.name : book?.short ?? name;
    const born = d?.born;
    const passed = d?.passed ?? passedYear.get(id);
    const minor = born !== undefined && input.today - born < 18;
    // A passing in the imagined future (demo story) does not stop a living adult hiding today.
    const isHidden = hidden.has(id) && !minor && (passed === undefined || passed > input.today);
    if (minor) { name = firstName(name); short = name; }
    if (isHidden) { name = ""; short = ""; }
    const since0 = born ?? firstSeen.get(id) ?? input.today;
    const since = input.span?.from !== undefined ? Math.max(since0, input.span.from) : since0;
    const org = !!(d?.org || orgs.has(id));
    const ph = visiblePhoto({ hidden: isHidden }, input.photos?.[id]);
    const photo = ph ? {
      src: ph.src, addedBy: ph.by, year: yearOf(ph.at),
      // Added by someone else for a person who has passed or has no wallet (not a child's, not a logo).
      memorial: !org && !minor && !wallets.includes(ph.by) && ph.by !== id && (wallets.length === 0 || (passed !== undefined && passed <= input.today)),
    } : null;
    return {
      id, name, short, wallets,
      ...(born !== undefined && !isHidden ? { born } : {}),
      ...(passed !== undefined ? { passed } : {}),
      hidden: isHidden, minor, since, generation: gens.get(id) ?? 0,
      ...(ownsEstate.has(id) ? { ownsEstate: ownsEstate.get(id) } : {}),
      ...(org ? { org: true } : {}),
      ...(photo ? { photo } : {}),
    };
  });
  const present = new Set(idList);

  // Asset steps name only people on the tree.
  const assets = assetPaths(events, ctx).map((a) => ({ ...a, steps: a.steps.map((s) => (s.to && !present.has(s.to) ? (({ to: _to, ...rest }) => { void _to; return rest; })(s) : s)) }));

  const lastYear = Math.max(input.today, ...events.map((e) => yearOf(e.ts)), ...people.map((p) => p.passed ?? 0));
  const span = {
    from: input.span?.from ?? Math.min(...people.map((p) => p.since), input.today),
    to: input.span?.to ?? lastYear,
  };
  return {
    estate: input.estate,
    mode: input.mode,
    people,
    relationships: [...input.relationships].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    kept,
    assets,
    generations: [...input.generations],
    span,
    today: input.today,
    partial: !!input.partial || input.estates.some((e) => !!e.partial),
  };
}

/** The whole tree, with its fingerprint. */
export async function deriveTree(input: DeriveInput): Promise<TreeSnapshot> {
  const body = deriveTreeBody(input);
  return { ...body, fingerprint: await treeFingerprint(body) };
}
