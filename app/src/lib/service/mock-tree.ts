/**
 * Trust Tree in the demo (mock mode): the Mokoena family over four generations, 1990 → 2086 (plan.md §15.5).
 *
 * - Up to today the story is the demo estate itself: whatever the visitor has done (signed the plan, payments,
 *   approvals, guardians, the passing if they played it) comes from the live mock snapshot, so the tree matches every
 *   other screen. If no plan is signed yet, Thabo's plan is pencilled in for tomorrow, marked imagined.
 * - After today everything is an imagined future (`imagined: true`; the page says "the years after 2026 are imagined"):
 *   Thabo keeps answering the children's requests and the plan pays fees until he passes in 2041; Adv. Ndlovu and
 *   Ms. Pillay confirm; the plan keeps paying his granddaughter Amahle's school fees to 2049; Uncle Bongani passes in
 *   2044 and Cousin Kagiso takes his seat; Aunt Zodwa's objection to a duplicate invoice is upheld; the Corolla passes
 *   to Lerato and the motorbike is sold under the hardship rules for Sipho; Lerato signs her own plan in 2041 (a
 *   generation link under Thabo's) and, when she passes in 2086, the Corolla passes on to Amahle.
 *   If the visitor already played Thabo's passing, the future follows from that year instead.
 * - Before Heirloom: Thabo's parents, Mkhulu Joseph and Gogo Martha, are people only (no trust lines).
 * Relationships the owner adds or removes, hidden flags and photos are kept with the rest of the demo state.
 * Photos (plan.md §15.11): the cast starts with illustrated avatars bundled with the app (lib/tree/avatars.ts, never
 * real people's faces), memorial ones for Mkhulu Joseph and Gogo Martha, and the charity's logo; the same consent
 * rules as on chain (lib/tree/photos.ts) decide who may change them.
 */
import type { Base58, Category } from "../types";
import type { EstateSnapshot } from "./types";
import { fail } from "./mock-errors";
import { deriveTree, deriveTreeBody, type DeclaredPerson, type DeriveInput, type TreeEstateInput } from "../tree/derive";
import type { TreeEvent } from "../tree/events";
import { relationshipId } from "../tree/links";
import { checkPhoto, photoConsent, type StoredPhoto } from "../tree/photos";
import { logoSvg, svgDataUrl } from "../tree/avatars";
import type { GenerationLink, PersonId, Relationship, RelationshipInput, RelationshipKind, TreeService, TreeSnapshot } from "../tree/types";

/** The demo cast's wallets (mock.ts passes the bound persona wallets). */
export interface MockTreeCast {
  estate: Base58;
  thabo: Base58; lerato: Base58; sipho: Base58; naledi: Base58;
  ndlovu: Base58; pillay: Base58; bongani: Base58; zodwa: Base58;
  kagiso: Base58; priya: Base58; charity: Base58;
}

/** Lerato's own plan (2041) and her daughter, both imagined. Made-up base58-looking addresses, like the demo's others. */
export const STORY_ESTATE_LERATO = "EsTaTe2LeRaToMoKoEnAvAuLt7xQp5sZc3FdYg8uE6rB";
export const STORY_AMAHLE = "AmAhLeMoKoEnAgRaNdDaUgHtEr5sZc3FdYg8uE6rAo1";
const MKHULU = "local:mkhulu-joseph";
const GOGO = "local:gogo-martha";
const STORY_CAR = "CaRStoRy1LeRaToCoRoLLa5sZc3FdYg8uE6rAoNFT1a";

export const STORY_SPAN = { from: 1990, to: 2086 } as const;

/** What the owner changed (persisted in the demo state). */
export interface MockTreeState {
  added: Relationship[];
  /** Ids of default relationships the owner removed. */
  removed: string[];
  hidden: Record<PersonId, boolean>;
  /** Photos set on this device, by person; null = the bundled illustration was removed. Added after the tree shipped. */
  photos?: Record<PersonId, StoredPhoto | null>;
}
export const blankTreeState = (): MockTreeState => ({ added: [], removed: [], hidden: {}, photos: {} });

const at = (year: number, month = 6, day = 15) => Date.UTC(year, month - 1, day, 10) / 1000;

/** A deterministic, clearly simulated transaction id (the demo shows "simulated" next to it). */
function simSigs() {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let seed = 20261117;
  return () => {
    let out = "SiM";
    for (let i = 0; i < 85; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += B58[seed % 58]; }
    return out;
  };
}

/** A story fact before its estate, simulated signature and imagined flag are filled in. */
type Draft = TreeEvent extends infer X ? X extends TreeEvent ? Omit<X, "sig" | "imagined" | "estate"> : never : never;

export interface MockStory {
  estates: TreeEstateInput[];
  people: DeclaredPerson[];
  relationships: Relationship[];
  generations: GenerationLink[];
}

/**
 * The scripted story around the live demo estate. `snap` is the mock estate when a plan is signed (else null);
 * `nowTs` is now (unix seconds).
 */
export function mockStory(c: MockTreeCast, snap: EstateSnapshot | null, nowTs: number): MockStory {
  const sig = simSigs();
  const E = c.estate, L = STORY_ESTATE_LERATO;
  const thabo: TreeEvent[] = [];
  const lerato: TreeEvent[] = [];
  const ev = (list: TreeEvent[], e: Draft) => { list.push({ ...e, estate: list === lerato ? L : E, sig: sig(), imagined: true } as TreeEvent); };
  const T = (e: Draft) => ev(thabo, e);
  const LE = (e: Draft) => ev(lerato, e);

  const thisYear = new Date(nowTs * 1000).getUTCFullYear();
  const next = thisYear + 1;
  const signed = !!snap;
  const startTs = signed ? Math.min(...snap.activity.map((a) => a.ts), nowTs) : nowTs + 86_400;

  // Thabo's plan as the demo has it (or, before it is signed, as the demo will sign it: pencilled in, imagined).
  if (!signed) {
    T({ kind: "EstateCreated", owner: c.thabo, ts: startTs });
    T({ kind: "VerifiersSet", verifiers: [c.ndlovu, c.pillay, c.bongani], ts: startTs });
    for (const w of [c.lerato, c.sipho, c.naledi]) T({ kind: "BeneficiaryAdded", wallet: w, ts: startTs });
  }
  // Rules: the demo's own where they exist, else story rules.
  let n = 0;
  const rule = (beneficiary: Base58, category: Category, ts: number, fresh = false): Base58 => {
    const hit = fresh ? undefined : snap?.rules.find((r) => r.beneficiary === beneficiary && r.category === category);
    if (hit) return hit.address;
    const id = `story-rule-${category}-${beneficiary.slice(0, 6)}-${n++}`;
    T({ kind: "RuleSet", rule: id, category, beneficiary, ts });
    return id;
  };
  const assetId = (pattern: RegExp, story: string) => snap?.assets.find((a) => pattern.test(a.title))?.address ?? story;
  const car = assetId(/corolla/i, "story-asset-corolla");
  const bike = assetId(/mustang|bike/i, "story-asset-motorbike");
  const carTitle = snap?.assets.find((a) => a.address === car)?.title ?? "2017 Toyota Corolla 1.8 Exclusive CVT";
  const bikeTitle = snap?.assets.find((a) => a.address === bike)?.title ?? "2025 Big Boy Mustang 250";
  if (!snap?.assets.some((a) => a.address === car)) T({ kind: "AssetRegistered", asset: car, title: carTitle, assetKind: "Car", ts: startTs });
  if (!snap?.assets.some((a) => a.address === bike)) T({ kind: "AssetRegistered", asset: bike, title: bikeTitle, assetKind: "Motorbike", ts: startTs });

  // Guardians: the demo's if set up, else Thabo sets them up early next year.
  if (!snap?.guardians?.enabled) {
    const g = at(next, 2, 10);
    T({ kind: "SeatConfigured", seat: 0, holder: c.ndlovu, backups: [], monitors: [], ts: g });
    T({ kind: "SeatConfigured", seat: 1, holder: c.pillay, backups: [], monitors: [], ts: g });
    T({ kind: "SeatConfigured", seat: 2, holder: c.bongani, backups: [c.kagiso, c.priya], monitors: [c.zodwa], ts: g });
    T({ kind: "FallbackSet", recipients: [c.lerato, c.sipho, c.naledi, c.charity], ts: g });
  }

  let claims = 0;
  const claim = (beneficiary: Base58, r: Base58, ts: number, how: { owner?: boolean; approvers?: Base58[]; paid?: boolean } = {}): Base58 => {
    const id = `story-claim-${claims++}`;
    T({ kind: "ClaimSubmitted", claim: id, rule: r, beneficiary, ts });
    if (how.owner) T({ kind: "ClaimOwnerApproved", claim: id, owner: c.thabo, ts: ts + 86_400 });
    for (const a of how.approvers ?? []) T({ kind: "ClaimApproved", claim: id, verifier: a, ts: ts + 86_400 });
    if (how.paid !== false) T({ kind: "ClaimPaid", claim: id, rule: r, ts: ts + 2 * 86_400 });
    return id;
  };

  // When Thabo passes: in 2041, or the year the visitor played it.
  const status = snap?.estate.status ?? "Active";
  const passedAlready = status === "Unlocked" || status === "DeathPending";
  const P = passedAlready ? thisYear : 2041;
  if (status === "DeathPending") T({ kind: "EstateUnlocked", ts: nowTs + 30 * 86_400 });

  const ruleBooks = rule(c.lerato, "Books", startTs);
  const ruleUni = rule(c.lerato, "Tuition", startTs);
  const ruleEveryday = rule(c.lerato, "General", startTs);
  const ruleSipho = rule(c.sipho, "Tuition", startTs);
  const ruleNaledi = rule(c.naledi, "Tuition", startTs);

  if (!passedAlready) {
    // While Thabo is alive: the living plan pays, and he answers the children's requests himself.
    for (let y = next; y <= Math.min(2030, P - 1); y++) {
      for (const m of [2, 6, 10]) T({ kind: "ScheduledPaid", rule: ruleBooks, ts: at(y, m, 1) });
      if (y <= 2029) { claim(c.lerato, ruleUni, at(y, 1, 20), { owner: true }); claim(c.lerato, ruleUni, at(y, 7, 20), { owner: true }); }
      claim(c.lerato, ruleEveryday, at(y, 4, 8), { owner: true });
    }
    for (let y = next; y <= 2031; y++) claim(c.sipho, ruleSipho, at(y, 2, 1), { owner: true });
    for (let y = next; y <= 2029; y++) claim(c.naledi, ruleNaledi, at(y, 1, 15), { owner: true });
    // 2030: Naledi's university fees, a new rule.
    const naledUni = rule(c.naledi, "Tuition", at(2030, 1, 5), true);
    for (let y = 2030; y <= 2033; y++) claim(c.naledi, naledUni, at(y, 2, 1), { owner: true });
    // 2033: Sipho reports his father's passing by mistake; Thabo says "I'm still here". Not shown against anyone.
    T({ kind: "DeathClaimSubmitted", by: c.sipho, ts: at(2033, 9, 3) });
    T({ kind: "DeathVetoed", ts: at(2033, 9, 4) });
    // 2037: Thabo adds his granddaughter Amahle (born 2036) and her school fees to his plan.
    T({ kind: "BeneficiaryAdded", wallet: STORY_AMAHLE, ts: at(2037, 3, 1) });
    // 2041: Thabo passes. Lerato reports it; Adv. Ndlovu and Ms. Pillay confirm; the plan unlocks.
    T({ kind: "DeathClaimSubmitted", by: c.lerato, ts: at(P, 3, 2) });
    T({ kind: "DeathAttested", verifier: c.ndlovu, ts: at(P, 3, 4) });
    T({ kind: "DeathAttested", verifier: c.pillay, ts: at(P, 3, 5) });
    T({ kind: "EstateUnlocked", ts: at(P, 4, 5) });
  }

  // After Thabo: school fees for the youngest still at school, approved by the trusted people.
  const seat2 = (y: number) => (y < Math.max(P + 3, 2034) ? c.bongani : c.kagiso);
  const bongPasses = Math.max(P + 3, 2034);
  const school = P >= 2037 ? { who: STORY_AMAHLE, rule: rule(STORY_AMAHLE, "Tuition", at(2037, 3, 1)), to: P + 8 } : { who: c.naledi, rule: ruleNaledi, to: 2029 };
  for (let y = P === thisYear ? next : P; y <= school.to; y++) {
    for (const m of [1, 7]) {
      const ts = at(y, m, 18);
      // 2046: Aunt Zodwa objects to a duplicate invoice Kagiso approved; it is upheld and never paid.
      if (y === Math.max(P + 5, bongPasses + 2) && m === 7) {
        const dup = claim(school.who, school.rule, ts, { approvers: [seat2(y)], paid: false });
        T({ kind: "ObjectionRaised", objection: "story-objection-1", target: dup, targetKind: "Claim", by: c.zodwa, ts: ts + 3 * 86_400 });
        T({ kind: "ObjectionResolved", objection: "story-objection-1", target: dup, targetKind: "Claim", upheld: true, ts: ts + 6 * 86_400 });
        continue;
      }
      claim(school.who, school.rule, ts, { approvers: [c.ndlovu, seat2(y)] });
    }
  }
  // A challenge that was dismissed: nothing is shown for or against anyone.
  const disputed = claim(school.who, school.rule, at(P + 6, 1, 25), { approvers: [c.ndlovu], paid: false });
  T({ kind: "DisputeRaised", dispute: "story-dispute-1", target: disputed, targetKind: "Claim", by: c.sipho, ts: at(P + 6, 2, 1) });
  T({ kind: "DisputeResolved", dispute: "story-dispute-1", target: disputed, targetKind: "Claim", upheld: false, ts: at(P + 6, 2, 9) });
  T({ kind: "ClaimPaid", claim: disputed, rule: school.rule, ts: at(P + 6, 2, 10) });

  // The Corolla passes to Lerato (unless the visitor already sold it), the motorbike is sold under the hardship rules for Sipho.
  const carSold = snap?.assets.find((a) => a.address === car)?.status === "Sold";
  const carListed = snap?.assets.find((a) => a.address === car)?.status === "Listed";
  const carTo = passedAlready ? at(next, 3, 1) : at(P, 6, 1);
  if (carListed) T({ kind: "AssetSold", asset: car, recipient: E, hardship: false, ts: carTo });
  else if (!carSold) T({ kind: "AssetPassed", asset: car, to: c.lerato, ts: carTo });
  const hardshipYear = passedAlready ? next + 1 : P + 1;
  T({ kind: "HardshipSubmitted", hardship: "story-hardship-1", asset: bike, beneficiary: c.sipho, ts: at(hardshipYear, 4, 2) });
  T({ kind: "HardshipApproved", hardship: "story-hardship-1", verifier: c.ndlovu, quorum: false, ts: at(hardshipYear, 4, 6) });
  T({ kind: "HardshipApproved", hardship: "story-hardship-1", verifier: seat2(hardshipYear), quorum: true, ts: at(hardshipYear, 4, 7) });
  T({ kind: "AssetSold", asset: bike, recipient: c.sipho, hardship: true, ts: at(hardshipYear, 5, 2) });

  // Uncle Bongani passes; Aunt Zodwa reports it, Ms. Pillay confirms, Cousin Kagiso takes the seat.
  T({ kind: "SeatDeathReported", seat: 2, holder: c.bongani, ts: at(bongPasses, 8, 1) });
  T({ kind: "SeatDeathConfirmed", seat: 2, by: c.pillay, ts: at(bongPasses, 8, 3) });
  T({ kind: "SuccessionFinalized", seat: 2, previous: c.bongani, next: c.kagiso, ts: at(bongPasses, 9, 3) });

  // Lerato's own plan (2041): Amahle is her beneficiary; Sipho, Naledi and Adv. Naidoo are her trusted people.
  const L0 = at(2041, 6, 20);
  LE({ kind: "EstateCreated", owner: c.lerato, ts: L0 });
  LE({ kind: "VerifiersSet", verifiers: [c.sipho, c.naledi, c.priya], ts: L0 });
  LE({ kind: "BeneficiaryAdded", wallet: STORY_AMAHLE, ts: L0 });
  // The Corolla she received carries on in her plan as one journey (a stand-in car if the visitor sold Thabo's).
  const lCar = carSold || carListed ? STORY_CAR : car;
  LE({ kind: "AssetRegistered", asset: lCar, title: carTitle, assetKind: "Car", ts: Math.max(at(2041, 7, 1), carTo + 86_400) });
  const lUni = "story-rule-lerato-amahle-uni", lDay = "story-rule-lerato-amahle-everyday";
  LE({ kind: "RuleSet", rule: lUni, category: "Tuition", beneficiary: STORY_AMAHLE, ts: L0 });
  LE({ kind: "RuleSet", rule: lDay, category: "General", beneficiary: STORY_AMAHLE, ts: L0 });
  let lc = 0;
  const lclaim = (r: Base58, ts: number) => {
    const id = `story-lclaim-${lc++}`;
    LE({ kind: "ClaimSubmitted", claim: id, rule: r, beneficiary: STORY_AMAHLE, ts });
    LE({ kind: "ClaimOwnerApproved", claim: id, owner: c.lerato, ts: ts + 86_400 });
    LE({ kind: "ClaimPaid", claim: id, rule: r, ts: ts + 2 * 86_400 });
  };
  for (let y = 2050; y <= 2060; y++) lclaim(lDay, at(y, 5, 10));
  for (let y = 2054; y <= 2057; y++) { lclaim(lUni, at(y, 1, 25)); lclaim(lUni, at(y, 7, 25)); }
  // 2086: Lerato passes; Sipho and Naledi confirm; the Corolla passes on to Amahle.
  LE({ kind: "DeathClaimSubmitted", by: STORY_AMAHLE, ts: at(2086, 2, 3) });
  LE({ kind: "DeathAttested", verifier: c.sipho, ts: at(2086, 2, 5) });
  LE({ kind: "DeathAttested", verifier: c.naledi, ts: at(2086, 2, 6) });
  LE({ kind: "EstateUnlocked", ts: at(2086, 3, 8) });
  LE({ kind: "AssetPassed", asset: lCar, to: STORY_AMAHLE, ts: at(2086, 5, 1) });

  const people: DeclaredPerson[] = [
    { id: MKHULU, name: "Mkhulu Joseph Mokoena", born: 1936, passed: 2003 },
    { id: GOGO, name: "Gogo Martha Mokoena", born: 1941, passed: 2019 },
    { id: c.bongani, name: "Uncle Bongani Mokoena", born: 1971 },
    { id: c.thabo, name: "Thabo Mokoena", born: 1976 },
    { id: c.zodwa, name: "Aunt Zodwa Mokoena", born: 1979 },
    { id: c.kagiso, name: "Cousin Kagiso Mokoena", born: 1998 },
    { id: c.lerato, name: "Lerato Mokoena", born: 2006 },
    { id: c.sipho, name: "Sipho Mokoena", born: 2008 },
    { id: c.naledi, name: "Naledi Mokoena", born: 2011 },
    { id: STORY_AMAHLE, name: "Amahle Mokoena", born: 2036 },
    { id: c.ndlovu, name: "Adv. Thandi Ndlovu" },
    { id: c.pillay, name: "Ms. Anita Pillay" },
    { id: c.priya, name: "Adv. Priya Naidoo" },
    { id: c.charity, name: "Ithemba Children's Charity", org: true },
  ];
  const declaredAt = signed ? startTs : nowTs;
  const rel = (kind: RelationshipKind, from: PersonId, to: PersonId, by: Base58 = c.thabo, ts = declaredAt): Relationship =>
    ({ id: relationshipId(kind, from, to), kind, from, to, declaredBy: by, declaredAt: ts });
  const relationships: Relationship[] = [
    rel("spouseOf", MKHULU, GOGO),
    ...[c.bongani, c.thabo, c.zodwa].flatMap((k) => [rel("parentOf", MKHULU, k), rel("parentOf", GOGO, k)]),
    ...[c.lerato, c.sipho, c.naledi].map((k) => rel("parentOf", c.thabo, k)),
    rel("parentOf", c.bongani, c.kagiso),
    rel("parentOf", c.lerato, STORY_AMAHLE, c.lerato, L0),
  ];
  return {
    estates: [
      { estate: E, owner: c.thabo, ...(snap ? { snapshot: snap } : {}), extra: thabo },
      { estate: L, owner: c.lerato, extra: lerato },
    ],
    people,
    relationships,
    generations: [{ parentEstate: E, childEstate: L, person: c.lerato, ts: L0 }],
  };
}

/** When the demo's photos were "added" (the year shows in the memorial label). */
const ILLUSTRATED_AT = Date.UTC(2026, 10, 17, 10) / 1000;

/** A bundled demo face (Unsplash stock, 256 px WebP made by scripts/demo-people-photos.mjs), served from our origin. */
const face = (id: string) => `/demo/people/${id}.webp`;

/**
 * The demo family's photos: each living adult's is their own; the owner added the black-and-white memorial photos of
 * his parents, his young daughter's and the charity's (drawn) logo; Lerato added her baby Amahle's. Cousin Kagiso has
 * none, so the demo also shows initials and "Add photo". A face that fails to load shows initials (components/tree/photo.tsx).
 */
export function demoPhotos(c: MockTreeCast): Record<PersonId, StoredPhoto> {
  const own = (id: PersonId, src: string) => [id, { src, by: id, at: ILLUSTRATED_AT }] as const;
  const owners = (id: PersonId, src: string) => [id, { src, by: c.thabo, at: ILLUSTRATED_AT }] as const;
  return Object.fromEntries([
    owners(MKHULU, face("mkhulu-joseph")),
    owners(GOGO, face("gogo-martha")),
    own(c.bongani, face("bongani")),
    own(c.thabo, face("thabo")),
    own(c.zodwa, face("zodwa")),
    own(c.lerato, face("lerato")),
    own(c.sipho, face("sipho")),
    owners(c.naledi, face("naledi")),
    [STORY_AMAHLE, { src: face("amahle"), by: c.lerato, at: ILLUSTRATED_AT }] as const,
    own(c.ndlovu, face("ndlovu")),
    own(c.pillay, face("pillay")),
    own(c.priya, face("priya")),
    owners(c.charity, svgDataUrl(logoSvg())),
  ]);
}

export interface MockTreeDeps {
  cast: MockTreeCast;
  /** The live demo estate, or null before a plan is signed. */
  snap(): EstateSnapshot | null;
  tree(): MockTreeState;
  me(): Base58;
  /** Unix seconds. */
  now(): number;
  wait(ms: number): Promise<void>;
  save(): void;
}

const PERSON = /^(local:[a-z0-9-]{1,40}|[1-9A-HJ-NP-Za-km-z]{32,48})$/;
const KINDS: RelationshipKind[] = ["parentOf", "spouseOf", "siblingOf"];

export function createMockTree(d: MockTreeDeps): TreeService {
  // The demo estate's owner is Thabo's persona, unless the visitor signed the plan with a wallet of their own.
  const cast = (): MockTreeCast => ({ ...d.cast, thabo: d.snap()?.estate.owner ?? d.cast.thabo });
  const ownerOf = (estate: Base58) => (estate === STORY_ESTATE_LERATO ? d.cast.lerato : cast().thabo);
  const needOwner = (estate: Base58) => { if (d.me() !== ownerOf(estate)) fail("NotOwner", "Only the estate owner can do this."); };

  function relationships(story: MockStory): Relationship[] {
    const st = d.tree();
    const removed = new Set(st.removed);
    const out = new Map<string, Relationship>();
    for (const r of [...story.relationships, ...st.added]) if (!removed.has(r.id)) out.set(r.id, r);
    return [...out.values()];
  }

  /** Bundled illustrations, then what was set or removed on this device. */
  function photos(): Record<PersonId, StoredPhoto> {
    const out: Record<PersonId, StoredPhoto> = demoPhotos(cast());
    for (const [id, p] of Object.entries(d.tree().photos ?? {})) { if (p) out[id] = p; else delete out[id]; }
    return out;
  }

  function input(estate: Base58): DeriveInput {
    const now = d.now();
    const story = mockStory(cast(), d.snap(), now);
    const st = d.tree();
    return {
      estate: estate === STORY_ESTATE_LERATO ? estate : d.cast.estate,
      mode: "mock",
      estates: story.estates,
      relationships: relationships(story),
      hidden: Object.entries(st.hidden).filter(([, h]) => h).map(([id]) => id),
      generations: story.generations,
      people: story.people,
      today: new Date(now * 1000).getUTCFullYear(),
      span: { ...STORY_SPAN },
      photos: photos(),
    };
  }

  /** Throws unless the signed-in persona may change this person's photo. */
  function needPhotoConsent(estate: Base58, person: PersonId) {
    const t = input(estate);
    const p = deriveTreeBody(t).people.find((x) => x.id === person);
    if (!p) fail("BadStatus", "That person is not on the tree.");
    if (!photoConsent(p!, d.me(), d.me() === ownerOf(estate), t.today)) {
      fail("NotOwner", p!.hidden ? "This person chose to hide from the tree." : "Only they can change their own photo, or the estate owner for a child, someone who has passed or an organisation.");
    }
  }

  return {
    async getTree(estate): Promise<TreeSnapshot> {
      await d.wait(150);
      return deriveTree(input(estate));
    },

    async setRelationship(estate, input: RelationshipInput) {
      await d.wait(400);
      needOwner(estate);
      if (!KINDS.includes(input.kind)) fail("BadStatus", "Choose how the two people are related.");
      if (!PERSON.test(input.from) || !PERSON.test(input.to)) fail("BadStatus", "Choose two people from the tree.");
      if (input.from === input.to) fail("BadStatus", "Choose two different people.");
      const st = d.tree();
      const id = relationshipId(input.kind, input.from, input.to);
      const reverse = input.kind === "parentOf" ? relationshipId("parentOf", input.to, input.from) : null;
      const existing = [...mockStory(cast(), d.snap(), d.now()).relationships, ...st.added].filter((r) => !st.removed.includes(r.id));
      if (reverse && existing.some((r) => r.id === reverse)) fail("BadStatus", "That would make someone their own grandparent.");
      st.removed = st.removed.filter((x) => x !== id);
      const hit = existing.find((r) => r.id === id);
      if (hit) { d.save(); return { ...hit }; }
      const r: Relationship = { id, kind: input.kind, from: input.from, to: input.to, declaredBy: d.me(), declaredAt: d.now() };
      st.added.push(r);
      d.save();
      return { ...r };
    },

    async removeRelationship(estate, id) {
      await d.wait(300);
      needOwner(estate);
      const st = d.tree();
      const isDefault = mockStory(cast(), d.snap(), d.now()).relationships.some((r) => r.id === id);
      const isAdded = st.added.some((r) => r.id === id);
      if ((!isDefault && !isAdded) || st.removed.includes(id)) fail("BadStatus", "That relationship is not on the tree.");
      st.added = st.added.filter((r) => r.id !== id);
      if (isDefault) st.removed.push(id);
      d.save();
    },

    async setHidden(_estate, hidden) {
      await d.wait(300);
      const me = d.me();
      d.tree().hidden[me] = hidden;
      d.save();
    },

    async setPhoto(estate, person, src) {
      await d.wait(300);
      const why = checkPhoto(src);
      if (why) fail("BadStatus", why === "size" ? "The photo is larger than 60 KB." : "The photo must be a WebP image.");
      needPhotoConsent(estate, person);
      const st = d.tree();
      st.photos = { ...(st.photos ?? {}), [person]: { src, by: d.me(), at: d.now() } };
      d.save();
    },

    async removePhoto(estate, person) {
      await d.wait(200);
      needPhotoConsent(estate, person);
      const st = d.tree();
      st.photos = { ...(st.photos ?? {}), [person]: null };
      d.save();
    },
  };
}
