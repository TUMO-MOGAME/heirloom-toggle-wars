/**
 * derive (people, edges, grouping, hidden and minor handling, generations), the timeline at a year, the fingerprint,
 * and the rule that nothing in a tree looks like an amount.
 */
import { describe, expect, it } from "vitest";
import type { EstateSnapshot } from "../service/types";
import type { Relationship } from "./types";
import { deriveTree, deriveTreeBody, generationsOf, type DeriveInput } from "./derive";
import type { TreeEvent } from "./events";
import { treeAtYear } from "./timeline";
import { canonicalTree, treeFingerprint } from "./fingerprint";
import { findAmounts } from "./no-amounts";
import { relationshipId } from "./links";
import { webpOf } from "./photo-fixture";

const E = "Estate1111111111111111111111111111111111111";
const OWNER = "Owner11111111111111111111111111111111111111";
const V = ["Verifier1111111111111111111111111111111111a", "Verifier2222222222222222222222222222222222b", "Verifier3333333333333333333333333333333333c"] as const;
const KID = "Kid1111111111111111111111111111111111111111";
const BABY = "Baby111111111111111111111111111111111111111";
const BACKUP = "Backup11111111111111111111111111111111111111";
const GRAN = "local:gran";
const Y = (y: number, m = 1) => Date.UTC(y, m - 1, 10) / 1000;

function snapshot(): EstateSnapshot {
  return {
    estate: {
      address: E, owner: OWNER, ownerName: "Thabo Mokoena", agent: "Agent1111111111111111111111111111111111111", usdtMint: "Mint111111111111111111111111111111111111111",
      verifiers: [...V], verifierNames: ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"],
      deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60, status: "Active", willHash: null, vaultBalance: 24_000_000_000n,
      death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null }, lastHeartbeat: Y(2026),
    },
    beneficiaries: [
      { address: "BenPda1111111111111111111111111111111111111", wallet: KID, label: "Lerato (daughter)", active: true },
      { address: "BenPda2222222222222222222222222222222222222", wallet: BABY, label: "Amahle (granddaughter)", active: true },
    ],
    payees: [{ address: "PayPda111111111111111111111111111111111111", wallet: "School111111111111111111111111111111111111", kind: "School", name: "Morris Isaacson High School" }],
    rules: [{ address: "rule1", id: 0, beneficiary: KID, category: "Tuition", allowedPayeeKind: "School", maxPerClaim: 1n, lifetimeCap: 9n, spentTotal: 2n, validUntil: Y(2040), startsNow: true, recurringAmount: 0n, intervalSecs: 0, nextDue: null, fixedPayee: null }],
    claims: [
      { address: "claim1", rule: "rule1", id: 0, beneficiary: KID, payee: "School111111111111111111111111111111111111", amount: 1n, evidenceHash: "0".repeat(64), agentVerdict: "Approved", approvals: [true, false, false], ownerApproved: false, status: "Paid", createdAt: Y(2026, 3) },
      { address: "claim2", rule: "rule1", id: 1, beneficiary: KID, payee: "School111111111111111111111111111111111111", amount: 1n, evidenceHash: "0".repeat(64), agentVerdict: "Approved", approvals: [true, false, false], ownerApproved: true, status: "Paid", createdAt: Y(2026, 9) },
    ],
    assets: [], offers: [], hardships: [],
    activity: [
      { ts: Y(2026), kind: "EstateCreated", text: "created", txSignature: "sigCreated" },
      { ts: Y(2026, 4), kind: "ClaimPaid", text: "paid", amount: 1n, txSignature: "sigPaid1", payment: { payee: "School111111111111111111111111111111111111", rule: "rule1", claim: "claim1" } },
    ],
  };
}

const rel = (kind: Relationship["kind"], from: string, to: string): Relationship => ({ id: relationshipId(kind, from, to), kind, from, to, declaredBy: OWNER, declaredAt: Y(2026) });
const RELS = [rel("spouseOf", GRAN, "local:grandad"), rel("parentOf", GRAN, OWNER), rel("parentOf", OWNER, KID), rel("parentOf", KID, BABY), rel("siblingOf", OWNER, V[2])];

function input(over: Partial<DeriveInput> = {}, extra: TreeEvent[] = []): DeriveInput {
  return {
    estate: E, mode: "chain",
    estates: [{ estate: E, owner: OWNER, snapshot: snapshot(), extra }],
    relationships: RELS, hidden: [], generations: [],
    people: [
      { id: GRAN, name: "Gogo Martha Mokoena", born: 1941, passed: 2019 },
      { id: "local:grandad", name: "Mkhulu Joseph Mokoena", born: 1936, passed: 2003 },
      { id: KID, name: "Lerato Mokoena", born: 2006 },
      { id: BABY, name: "Amahle Mokoena", born: 2036 },
      { id: OWNER, born: 1976 },
    ],
    today: 2026,
    ...over,
  };
}

const succession: TreeEvent[] = [
  { estate: E, ts: Y(2027), sig: "s1", kind: "SeatConfigured", seat: 2, holder: V[2], backups: [BACKUP], monitors: [] },
  { estate: E, ts: Y(2044), sig: "s2", kind: "SeatDeathConfirmed", seat: 2, by: V[1] },
  { estate: E, ts: Y(2044, 3), sig: "s3", kind: "SuccessionFinalized", seat: 2, previous: V[2], next: BACKUP },
];

describe("deriveTree", () => {
  it("collects the people: owner, roles, relationships and declared people, with names from the estate's name book", () => {
    const t = deriveTreeBody(input());
    const byId = new Map(t.people.map((p) => [p.id, p]));
    expect(byId.get(OWNER)).toMatchObject({ name: "Thabo Mokoena", short: "Thabo", born: 1976, ownsEstate: E, wallets: [OWNER] });
    expect(byId.get(V[0])).toMatchObject({ name: "Adv. Thandi Ndlovu", short: "Adv. Ndlovu" });
    expect(byId.get(KID)).toMatchObject({ name: "Lerato Mokoena", minor: false });
    expect(byId.get(GRAN)).toMatchObject({ name: "Gogo Martha Mokoena", wallets: [], passed: 2019 });
    // Institutions (payees) are not people on the tree.
    expect(byId.has("School111111111111111111111111111111111111")).toBe(false);
  });

  it("derives trust edges from roles and closes them when a successor takes the seat", () => {
    const t = deriveTreeBody(input({}, succession));
    const roles = t.edges.map((e) => [e.role, e.to, e.toTs !== undefined]);
    expect(roles).toEqual(expect.arrayContaining([
      ["trustedPerson", V[0], false], ["trustedPerson", V[2], true], ["beneficiary", KID, false], ["beneficiary", BABY, false],
      ["successor", BACKUP, true], ["guardian", BACKUP, false],
    ]));
    expect(t.edges.every((e) => e.from === OWNER && e.estate === E)).toBe(true);
    expect(t.people.find((p) => p.id === V[2])?.passed).toBe(2044);
  });

  it("groups kept promises from the snapshot (approvals, owner answers, payments) and thickens the matching edges", () => {
    const t = deriveTreeBody(input());
    const approved = t.kept.find((k) => k.kind === "approvedPayments")!;
    expect(approved).toMatchObject({ by: V[0], for: [KID], count: 2, purpose: "Tuition" });
    expect(t.kept.find((k) => k.kind === "answeredRequests")).toMatchObject({ by: OWNER, for: [KID], count: 1 });
    expect(t.kept.find((k) => k.kind === "planPaid")).toMatchObject({ by: OWNER, for: [KID], count: 2 });
    expect(t.edges.find((e) => e.role === "trustedPerson" && e.to === V[0])!.keptCount).toBe(2);
    expect(t.edges.find((e) => e.role === "beneficiary" && e.to === KID)!.keptCount).toBe(3);
  });

  it("hides a living adult who chose to (name and years gone, edges kept); a minor shows the first name only", () => {
    const t = deriveTreeBody(input({ hidden: [V[0], BABY, GRAN] }));
    const v = t.people.find((p) => p.id === V[0])!;
    expect(v).toMatchObject({ hidden: true, name: "", short: "" });
    expect(t.edges.some((e) => e.to === V[0])).toBe(true);
    const baby = t.people.find((p) => p.id === BABY)!;
    expect(baby).toMatchObject({ minor: true, hidden: false, name: "Amahle", short: "Amahle" });
    // Hiding is for living adults: someone who has passed stays named.
    expect(t.people.find((p) => p.id === GRAN)).toMatchObject({ hidden: false, name: "Gogo Martha Mokoena" });
  });

  it("puts generations in rows: parents above children, spouses and siblings together, outsiders on the truster's row", () => {
    const t = deriveTreeBody(input());
    const g = Object.fromEntries(t.people.map((p) => [p.id, p.generation]));
    expect([g[GRAN], g["local:grandad"], g[OWNER], g[V[2]], g[KID], g[BABY]]).toEqual([0, 0, 1, 1, 2, 3]);
    expect(g[V[0]]).toBe(1); // not family: the owner's row
    expect(generationsOf(["a", "b"], [], [])).toEqual(new Map([["a", 0], ["b", 0]]));
  });

  it("sets the span from the people and today, or the fixed span given", () => {
    expect(deriveTreeBody(input()).span).toEqual({ from: 1936, to: 2026 });
    const fixed = deriveTreeBody(input({ span: { from: 1990, to: 2086 } }));
    expect(fixed.span).toEqual({ from: 1990, to: 2086 });
    expect(fixed.people.find((p) => p.id === GRAN)!.since).toBe(1990);
  });

  it("never carries an amount, even though the snapshot it reads is full of them", async () => {
    const t = await deriveTree(input({}, succession));
    expect(findAmounts(snapshot()).length).toBeGreaterThan(0); // the checker does find them in a snapshot
    expect(findAmounts(t)).toEqual([]);
  });
});

describe("treeAtYear", () => {
  it("shows who was there, who had passed, the edges that had started and only what was kept by then", () => {
    const extra: TreeEvent[] = [
      ...succession,
      ...[2041, 2045, 2049].flatMap((y, i): TreeEvent[] => [
        { estate: E, ts: Y(y), sig: `c${i}`, kind: "ClaimSubmitted", claim: `later${i}`, rule: "rule1", beneficiary: BABY },
        { estate: E, ts: Y(y, 2), sig: `a${i}`, kind: "ClaimApproved", claim: `later${i}`, verifier: V[0] },
      ]),
    ];
    const t = deriveTreeBody({ ...input({}, extra), today: 2026 });
    const at2000 = treeAtYear({ ...t, fingerprint: "x" }, 2000);
    expect(at2000.people.map((p) => p.id).sort()).toEqual([GRAN, "local:grandad", OWNER].sort());
    expect(at2000.edges).toEqual([]);
    expect(at2000.people.find((p) => p.id === GRAN)).toMatchObject({ alive: true });
    expect(at2000.people.find((p) => p.id === GRAN)!.passed).toBeUndefined();

    const at2045 = treeAtYear({ ...t, fingerprint: "x" }, 2045);
    expect(at2045.people.find((p) => p.id === GRAN)).toMatchObject({ alive: false, passed: 2019 });
    expect(at2045.people.find((p) => p.id === V[2])).toMatchObject({ alive: false, passed: 2044 });
    const forBaby = at2045.kept.find((k) => k.kind === "approvedPayments" && k.for[0] === BABY)!;
    expect(forBaby.count).toBe(2); // 2041 and 2045, not yet 2049
    expect(at2045.edges.find((e) => e.role === "trustedPerson" && e.to === V[2])!.toTs).toBeDefined();
    expect(at2045.edges.find((e) => e.role === "guardian")).toBeDefined();
    const at2043 = treeAtYear({ ...t, fingerprint: "x" }, 2043);
    expect(at2043.edges.find((e) => e.role === "trustedPerson" && e.to === V[2])!.toTs).toBeUndefined();
    expect(at2043.edges.find((e) => e.role === "trustedPerson" && e.to === V[0])!.keptCount).toBe(3);
    expect(treeAtYear({ ...t, fingerprint: "x" }, 2049).edges.find((e) => e.role === "trustedPerson" && e.to === V[0])!.keptCount).toBe(5);
  });
});

describe("fingerprint", () => {
  it("is stable for the same tree, ignores names, hidden flags and order, and changes with the relationships", async () => {
    const a = await deriveTree(input());
    const b = await deriveTree(input({ relationships: [...RELS].reverse() }));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    const renamed = await deriveTree(input({ people: [{ id: KID, name: "Someone Else", born: 2006 }, { id: GRAN, name: "X" }] }));
    expect(renamed.fingerprint).toBe(a.fingerprint);
    expect((await deriveTree(input({ hidden: [V[0]] }))).fingerprint).toBe(a.fingerprint);
    // Spouses in either order are the same relationship.
    const flipped = RELS.map((r) => (r.kind === "spouseOf" ? { ...r, from: r.to, to: r.from } : r));
    expect((await deriveTree(input({ relationships: flipped }))).fingerprint).toBe(a.fingerprint);
    expect((await deriveTree(input({ relationships: RELS.slice(1) }))).fingerprint).not.toBe(a.fingerprint);
    expect(JSON.stringify(canonicalTree(a))).not.toMatch(/Mokoena|Lerato|Ndlovu/);
    expect(await treeFingerprint(a)).toBe(a.fingerprint);
  });
});

describe("photos on the tree (plan.md §15.11)", () => {
  const photos = {
    [V[0]]: { src: webpOf(100), by: V[0], at: Y(2026) },
    [GRAN]: { src: webpOf(200), by: OWNER, at: Y(2026, 11) },
    [BABY]: { src: webpOf(300), by: OWNER, at: Y(2026) },
    [KID]: { src: webpOf(400), by: KID, at: Y(2026) },
  };

  it("puts each photo on its person; a memorial photo (passed or no wallet, added by someone else) says who added it", () => {
    const t = deriveTreeBody(input({ photos }));
    const p = (id: string) => t.people.find((x) => x.id === id)!;
    expect(p(GRAN).photo).toEqual({ src: photos[GRAN].src, addedBy: OWNER, year: 2026, memorial: true });
    expect(p(V[0]).photo).toMatchObject({ addedBy: V[0], memorial: false });
    // A child's photo is the parent's choice, not a memorial.
    expect(p(BABY).photo).toMatchObject({ addedBy: OWNER, memorial: false });
    expect(p(OWNER).photo).toBeUndefined();
  });

  it("never shows a hidden person's photo, at any year on the slider", () => {
    const t = deriveTreeBody(input({ photos, hidden: [V[0], KID] }));
    expect(t.people.find((x) => x.id === V[0])).toMatchObject({ hidden: true });
    expect(t.people.find((x) => x.id === V[0])!.photo).toBeUndefined();
    expect(t.people.find((x) => x.id === KID)!.photo).toBeUndefined();
    // Hiding is for living adults: the child's photo stays.
    expect(t.people.find((x) => x.id === BABY)!.photo).toBeDefined();
    for (const y of [2026, 2040, 2060]) expect(treeAtYear({ ...t, fingerprint: "x" }, y).people.find((x) => x.id === V[0])?.photo).toBeUndefined();
  });

  it("leaves the fingerprint unchanged when a photo is added, changed or removed", async () => {
    const none = await deriveTree(input());
    const some = await deriveTree(input({ photos }));
    const changed = await deriveTree(input({ photos: { ...photos, [GRAN]: { src: webpOf(999), by: OWNER, at: Y(2030) } } }));
    expect(some.fingerprint).toBe(none.fingerprint);
    expect(changed.fingerprint).toBe(none.fingerprint);
    expect(JSON.stringify(canonicalTree(some))).not.toContain("data:image");
    expect(findAmounts(some)).toEqual([]);
  });
});
