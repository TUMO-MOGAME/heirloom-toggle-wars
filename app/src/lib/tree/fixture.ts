/**
 * Test fixture for the Trust Tree screen (components/tree/tree.test.ts, lib/tree/layout.test.ts): the Mokoena family
 * over four generations, 1990 → 2086, "today" 2026, with an imagined story after it. The live screen reads the
 * service (lib/service/mock-tree.ts on the demo); this is only for tests. No amounts anywhere.
 */
import type { AssetPath, KeptPromise, Relationship, TreePerson, TreeSnapshot, TrustEdge, TrustRole } from "./types";
import { DEMO_PERSONAS } from "../wallet/personas";

const TODAY = 2026;
/** Unix seconds for the middle of a month. */
export const yearTs = (year: number, month = 6) => Math.floor(Date.UTC(year, month - 1, 15, 12) / 1000);

const w = (key: string) => {
  const p = DEMO_PERSONAS.find((x) => x.label.toLowerCase().startsWith(key));
  if (!p) throw new Error(`fixture: no persona ${key}`);
  return p.address;
};
const THABO = w("thabo"), LERATO = w("lerato"), SIPHO = w("sipho"), NALEDI = w("naledi");
const NDLOVU = w("adv. thandi"), PILLAY = w("ms. anita"), BONGANI = w("uncle bongani"), ZODWA = w("aunt zodwa");
const KAGISO = "8QDekGfekh5Bg85sbkoW5EQpxQmoqbL1SY3m3ieyW9BH";
const PRIYA = "34biue8WinN94cpC41bcp6YkG5EUWicexxjd3zyjcnQ1";
const JOSEPH = "local:joseph-mokoena", MARTHA = "local:martha-mokoena", MPHO = "local:mpho-mokoena";
const TUMELO = "local:tumelo-dube", AMAHLE = "local:amahle-mokoena";
const THABO_ESTATE = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const LERATO_ESTATE = "LeRaTo4MoKoEnApLaNfAmiLyVauLt2xQp5sZc3FdYg8u";

function person(id: string, name: string, generation: number, o: Partial<TreePerson> = {}): TreePerson {
  const short = name.split(" ")[0] === "Adv." || name.split(" ")[0] === "Ms." ? `${name.split(" ")[0]} ${name.split(" ").at(-1)}`
    : /^(Uncle|Aunt|Cousin|Gogo|Mkhulu)$/.test(name.split(" ")[0]) ? name.split(" ").slice(0, 2).join(" ") : name.split(" ")[0];
  const born = o.born;
  return {
    id, name, short, wallets: id.startsWith("local:") ? [] : [id], hidden: false, minor: false,
    since: Math.max(1990, born ?? 1990), generation, ...o,
  };
}

/** A made-up receipt id: "MOCK" + base58-ish text, so nobody mistakes it for a real signature. */
let seq = 0;
const sig = (tag: string) => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let h = 2166136261;
  for (const c of `${tag}:${seq++}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  let out = "MOCK";
  for (let i = 0; i < 60; i++) { h = Math.imul(h ^ i, 16777619) >>> 0; out += alphabet[h % alphabet.length]; }
  return out;
};

function build(estate: string, mode: "mock" | "chain"): TreeSnapshot {
  seq = 0;
  const people: TreePerson[] = [
    person(JOSEPH, "Mkhulu Joseph Mokoena", 0, { born: 1938, passed: 2011 }),
    person(MARTHA, "Gogo Martha Mokoena", 0, { born: 1942, passed: 2019 }),
    person(BONGANI, "Uncle Bongani Mokoena", 1, { born: 1968, passed: 2048 }),
    person(THABO, "Thabo Mokoena", 1, { born: 1972, passed: 2034, ownsEstate: THABO_ESTATE }),
    person(MPHO, "Mpho Mokoena", 1, { born: 1974, passed: 2061, since: 1996 }),
    person(ZODWA, "Aunt Zodwa Mokoena", 1, { born: 1976, passed: 2069 }),
    person(NDLOVU, "Adv. Thandi Ndlovu", 1, { since: TODAY }),
    person(PILLAY, "Ms. Anita Pillay", 1, { since: TODAY }),
    person(PRIYA, "Adv. Priya Naidoo", 1, { since: TODAY }),
    // The hidden adult: a living adult who chose to hide (no name; roles stay).
    { ...person(KAGISO, "", 2, { born: 1999 }), name: "", short: "", hidden: true },
    person(TUMELO, "Tumelo Dube", 2, { born: 2004, since: 2033 }),
    person(LERATO, "Lerato Mokoena", 2, { born: 2006, passed: 2055, ownsEstate: LERATO_ESTATE }),
    person(SIPHO, "Sipho Mokoena", 2, { born: 2008 }),
    // The minor: 15 today, so first name only and no card details while under 18.
    person(NALEDI, "Naledi Mokoena", 2, { born: 2011, minor: true }),
    person(AMAHLE, "Amahle Mokoena", 3, { born: 2041 }),
  ];

  const rel = (kind: Relationship["kind"], from: string, to: string, year: number): Relationship => ({
    id: `rel-${kind}-${from}-${to}`, kind, from, to, declaredBy: THABO, declaredAt: yearTs(Math.max(year, TODAY), 3),
  });
  const relationships: Relationship[] = [
    rel("spouseOf", JOSEPH, MARTHA, 1990),
    ...[BONGANI, THABO, ZODWA].map((c) => rel("parentOf", JOSEPH, c, 1990)),
    ...[BONGANI, THABO, ZODWA].map((c) => rel("parentOf", MARTHA, c, 1990)),
    rel("spouseOf", THABO, MPHO, 1996),
    ...[LERATO, SIPHO, NALEDI].flatMap((c) => [rel("parentOf", THABO, c, 2006), rel("parentOf", MPHO, c, 2006)]),
    rel("parentOf", BONGANI, KAGISO, 1999),
    { ...rel("spouseOf", LERATO, TUMELO, 2033), declaredBy: LERATO },
    { ...rel("parentOf", LERATO, AMAHLE, 2041), declaredBy: LERATO },
    { ...rel("parentOf", TUMELO, AMAHLE, 2041), declaredBy: LERATO },
  ];

  const edges: TrustEdge[] = [];
  const edge = (from: string, to: string, role: TrustRole, est: string, fromYear: number, toYear?: number, month = 4) => {
    edges.push({
      id: `edge-${role}-${to}-${est.slice(0, 6)}`, from, to, role, estate: est,
      fromTs: yearTs(fromYear, month), toTs: toYear ? yearTs(toYear, 9) : undefined, keptCount: 0,
    });
  };
  // Thabo's plan (2026, today): trusted people, the guardian seat for Naledi, the heirs, backups and a watcher.
  edge(THABO, NDLOVU, "trustedPerson", THABO_ESTATE, 2026, 2038);
  edge(THABO, PILLAY, "trustedPerson", THABO_ESTATE, 2026, 2034);
  edge(THABO, BONGANI, "trustedPerson", THABO_ESTATE, 2026, 2034);
  edge(THABO, BONGANI, "guardian", THABO_ESTATE, 2026, 2036, 5);
  edge(THABO, KAGISO, "successor", THABO_ESTATE, 2026, 2036, 5);
  edge(THABO, PRIYA, "successor", THABO_ESTATE, 2026, 2036, 5);
  edge(THABO, ZODWA, "monitor", THABO_ESTATE, 2026, 2036, 5);
  edge(THABO, LERATO, "beneficiary", THABO_ESTATE, 2026, 2034, 2);
  edge(THABO, SIPHO, "beneficiary", THABO_ESTATE, 2026, 2038, 2);
  edge(THABO, NALEDI, "beneficiary", THABO_ESTATE, 2026, 2036, 2);
  edge(THABO, LERATO, "heir", THABO_ESTATE, 2026, 2034, 7);
  edge(THABO, SIPHO, "fallback", THABO_ESTATE, 2026, 2034, 7);
  // Lerato's own plan (2041, imagined): her brother and sister are trusted, Naledi holds the seat for Amahle.
  edge(LERATO, SIPHO, "trustedPerson", LERATO_ESTATE, 2041, 2058);
  edge(LERATO, NALEDI, "trustedPerson", LERATO_ESTATE, 2041, 2058);
  edge(LERATO, NALEDI, "guardian", LERATO_ESTATE, 2041, 2062, 5);
  edge(LERATO, SIPHO, "successor", LERATO_ESTATE, 2041, 2062, 5);
  edge(LERATO, AMAHLE, "beneficiary", LERATO_ESTATE, 2041, 2066, 2);
  edge(LERATO, AMAHLE, "heir", LERATO_ESTATE, 2041, 2062, 7);

  const kept: KeptPromise[] = [];
  const promise = (p: Omit<KeptPromise, "id" | "proofs" | "imagined" | "firstTs" | "lastTs"> & { from: number; to?: number; month?: number }) => {
    const { from, to, month = 8, ...rest } = p;
    const n = Math.min(5, rest.count);
    kept.push({
      ...rest, id: `kept-${rest.kind}-${rest.by.slice(-6)}-${from}`, firstTs: yearTs(from, month), lastTs: yearTs(to ?? from, month + 2 > 12 ? 12 : month + 2),
      proofs: Array.from({ length: n }, () => sig(rest.kind)), imagined: from > TODAY || (to ?? from) > TODAY,
    });
  };
  // Up to today (the demo estate's real mock events): the plan paid Lerato's fees; Thabo answered her request.
  promise({ kind: "planPaid", by: THABO, for: [LERATO], estate: THABO_ESTATE, count: 3, purpose: "Tuition", from: 2026, month: 2 });
  promise({ kind: "answeredRequests", by: THABO, for: [LERATO], estate: THABO_ESTATE, count: 1, from: 2026, month: 10 });
  // Imagined: Thabo's living plan keeps paying, then his passing is confirmed and the trusted people take over.
  promise({ kind: "planPaid", by: THABO, for: [LERATO], estate: THABO_ESTATE, count: 12, purpose: "Tuition", from: 2027, to: 2029 });
  promise({ kind: "planPaid", by: THABO, for: [SIPHO], estate: THABO_ESTATE, count: 9, purpose: "Books", from: 2027, to: 2033 });
  promise({ kind: "answeredRequests", by: THABO, for: [LERATO, SIPHO, NALEDI], estate: THABO_ESTATE, count: 14, from: 2027, to: 2033 });
  promise({ kind: "confirmedPassing", by: NDLOVU, for: [], about: THABO, estate: THABO_ESTATE, count: 1, withOthers: 1, from: 2034, month: 3 });
  promise({ kind: "confirmedPassing", by: BONGANI, for: [], about: THABO, estate: THABO_ESTATE, count: 1, withOthers: 1, from: 2034, month: 3 });
  promise({ kind: "approvedPayments", by: NDLOVU, for: [SIPHO], estate: THABO_ESTATE, count: 8, purpose: "Tuition", from: 2034, to: 2038 });
  promise({ kind: "approvedPayments", by: PILLAY, for: [LERATO], estate: THABO_ESTATE, count: 2, purpose: "Accommodation", from: 2034 });
  promise({ kind: "guardianTerm", by: BONGANI, for: [NALEDI], estate: THABO_ESTATE, count: 1, from: 2034, to: 2036, month: 4 });
  promise({ kind: "approvedPayments", by: BONGANI, for: [NALEDI], estate: THABO_ESTATE, count: 12, purpose: "Tuition", from: 2034, to: 2036 });
  promise({ kind: "helpedHardship", by: BONGANI, for: [SIPHO], estate: THABO_ESTATE, count: 1, from: 2035 });
  promise({ kind: "carriedOutFallback", by: SIPHO, for: [], about: THABO, estate: THABO_ESTATE, count: 1, from: 2036 });
  promise({ kind: "raisedUpheldChallenge", by: ZODWA, for: [], estate: THABO_ESTATE, count: 1, from: 2035, month: 11 });
  promise({ kind: "challengeUpheld", by: KAGISO, for: [], estate: THABO_ESTATE, count: 1, from: 2035, month: 11 });
  // Lerato's plan: she answers her daughter's requests; after her passing Naledi is Amahle's guardian.
  promise({ kind: "answeredRequests", by: LERATO, for: [AMAHLE], estate: LERATO_ESTATE, count: 6, from: 2049, to: 2054 });
  promise({ kind: "confirmedPassing", by: SIPHO, for: [], about: LERATO, estate: LERATO_ESTATE, count: 1, withOthers: 1, from: 2055, month: 5 });
  promise({ kind: "confirmedPassing", by: NALEDI, for: [], about: LERATO, estate: LERATO_ESTATE, count: 1, withOthers: 1, from: 2055, month: 5 });
  promise({ kind: "guardianTerm", by: NALEDI, for: [AMAHLE], estate: LERATO_ESTATE, count: 1, from: 2055, to: 2062, month: 6 });
  promise({ kind: "approvedPayments", by: NALEDI, for: [AMAHLE], estate: LERATO_ESTATE, count: 21, purpose: "Tuition", from: 2056, to: 2062 });
  promise({ kind: "approvedPayments", by: SIPHO, for: [AMAHLE], estate: LERATO_ESTATE, count: 4, purpose: "Medical", from: 2057, to: 2060 });
  promise({ kind: "planPaid", by: LERATO, for: [AMAHLE], estate: LERATO_ESTATE, count: 7, purpose: "Books", from: 2056, to: 2062 });

  // Line thickness: the promises kept along each edge (by the person the edge points to, in that estate).
  for (const e of edges) e.keptCount = kept.filter((k) => k.by === e.to && k.estate === e.estate && k.kind !== "challengeUpheld").reduce((n, k) => n + k.count, 0);

  const step = (kind: AssetPath["steps"][number]["kind"], year: number, month: number, to?: string) =>
    ({ kind, ts: yearTs(year, month), to, proof: sig(kind), imagined: year > TODAY });
  const assets: AssetPath[] = [
    {
      id: "asset-corolla", kind: "Car", title: "2017 Toyota Corolla", owner: THABO, estate: THABO_ESTATE,
      steps: [step("registered", 2026, 3), step("heldByPlan", 2026, 4), step("passedTo", 2034, 9, LERATO), step("registered", 2041, 4), step("passedTo", 2062, 9, AMAHLE)],
    },
    {
      id: "asset-motorbike", kind: "Motorbike", title: "2019 Honda motorbike", owner: THABO, estate: THABO_ESTATE,
      steps: [step("registered", 2026, 5), step("heldByPlan", 2026, 5), step("soldUnderRules", 2035, 2)],
    },
    {
      id: "asset-ring", kind: "Jewellery", title: "Gogo Martha's gold ring", owner: LERATO, estate: LERATO_ESTATE,
      steps: [step("registered", 2041, 6), step("heldByPlan", 2041, 6), step("passedTo", 2066, 3, AMAHLE)],
    },
  ];

  return {
    estate, mode, people, relationships, edges, kept, assets,
    generations: [{ parentEstate: THABO_ESTATE, childEstate: LERATO_ESTATE, person: LERATO, ts: yearTs(2041, 4) }],
    span: { from: 1990, to: 2086 }, today: TODAY,
    fingerprint: "7f3a9c2e5b1d48f6a0c3e9b2d7f14a6c8e0b5d3f2a9c7e1b4d6f8a0c2e5b7d93",
    partial: false,
  };
}

/** A fresh copy of the fixture tree, seen from `estate`. */
export function treeFixture(estate: string, mode: "mock" | "chain" = "mock"): TreeSnapshot {
  return build(estate, mode);
}

export const FIXTURE_IDS = { THABO, LERATO, SIPHO, NALEDI, NDLOVU, BONGANI, ZODWA, KAGISO, AMAHLE, JOSEPH } as const;
