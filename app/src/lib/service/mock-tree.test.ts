/**
 * The demo's Trust Tree: the Mokoena family 1990 → 2086 around the live demo estate, imagined after today, Lerato's
 * own plan linked under Thabo's; relationships and hidden flags editable and kept with the demo state.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMockService, DEMO_GUARDIANS, DEMO_PERSONAS, type MockService } from "./mock";
import { STORY_AMAHLE, STORY_ESTATE_LERATO } from "./mock-tree";
import { findAmounts } from "../tree/no-amounts";
import { treeAtYear } from "../tree/timeline";
import { relationshipId } from "../tree/links";
import { webpOf } from "../tree/photo-fixture";
import type { TreeSnapshot } from "../tree/types";

const P = Object.fromEntries(DEMO_PERSONAS.map((p) => [p.key, p]));
const year = (ts: number) => new Date(ts * 1000).getUTCFullYear();
const thisYear = new Date().getUTCFullYear();

/** In-memory localStorage, so the demo state persists between services like in a browser. */
class Mem { data = new Map<string, string>(); getItem(k: string) { return this.data.get(k) ?? null; } setItem(k: string, v: string) { this.data.set(k, v); } removeItem(k: string) { this.data.delete(k); } }
let storage: Mem;
beforeEach(() => {
  storage = new Mem();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return () => { delete (globalThis as { window?: unknown }).window; };
});

function service(stage: Parameters<MockService["resetDemo"]>[0] = "funded") {
  const s = createMockService({ instant: true });
  s.resetDemo(stage);
  return s;
}
const act = (s: MockService, key: string) => s.setActor({ address: P[key].address, role: P[key].role, label: P[key].label });
async function tree(s: MockService): Promise<TreeSnapshot> { return s.getTree((await s.listEstatesFor(P.thabo.address))[0]?.estate ?? "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo"); }
const person = (t: TreeSnapshot, id: string) => t.people.find((p) => p.id === id)!;

describe("the demo story", () => {
  it("spans 1990–2086 over four generations, from Thabo's parents to his granddaughter", async () => {
    const t = await tree(service());
    expect(t.mode).toBe("mock");
    expect(t.span).toEqual({ from: 1990, to: 2086 });
    expect(t.today).toBe(thisYear);
    expect(new Set(t.people.map((p) => p.generation))).toEqual(new Set([0, 1, 2, 3]));
    expect(person(t, "local:mkhulu-joseph")).toMatchObject({ name: "Mkhulu Joseph Mokoena", generation: 0, passed: 2003 });
    expect(person(t, P.thabo.address)).toMatchObject({ name: "Thabo Mokoena", generation: 1, passed: 2041 });
    expect(person(t, P.busi.address)).toMatchObject({ name: "Uncle Bongani Mokoena", generation: 1, passed: 2044 });
    expect(person(t, P.lerato.address)).toMatchObject({ name: "Lerato Mokoena", generation: 2, passed: 2086, ownsEstate: STORY_ESTATE_LERATO });
    expect(person(t, P.naledi.address)).toMatchObject({ minor: true, name: "Naledi" });
    expect(person(t, STORY_AMAHLE)).toMatchObject({ generation: 3, minor: true, name: "Amahle", since: 2036 });
    // Thabo's parents were there before Heirloom: people only, no trust lines.
    expect(t.edges.some((e) => e.from.startsWith("local:") || e.to.startsWith("local:"))).toBe(false);
  });

  it("uses the live demo estate up to today and marks everything after today as imagined", async () => {
    const t = await tree(service());
    const real = t.kept.filter((k) => !k.imagined);
    expect(real.length).toBeGreaterThan(0); // the funded demo's first scheduled book payment
    expect(real.every((k) => year(k.lastTs) <= thisYear)).toBe(true);
    const later = t.kept.filter((k) => year(k.firstTs) > thisYear);
    expect(later.length).toBeGreaterThan(10);
    expect(later.every((k) => k.imagined)).toBe(true);
    expect(t.assets.flatMap((a) => a.steps).filter((s) => year(s.ts) > thisYear).every((s) => s.imagined)).toBe(true);
  });

  it("tells the key moments: passings confirmed, school fees to 2049, Kagiso's seat, an upheld objection, the Corolla's path", async () => {
    const t = await tree(service());
    const k = (kind: string, by: string) => t.kept.filter((x) => x.kind === kind && x.by === by);
    expect(k("confirmedPassing", P.nomsa.address).some((x) => x.about === P.thabo.address && year(x.firstTs) === 2041 && x.withOthers === 1)).toBe(true);
    const fees = k("approvedPayments", P.nomsa.address).find((x) => x.for[0] === STORY_AMAHLE)!;
    expect([year(fees.firstTs), year(fees.lastTs)]).toEqual([2041, 2049]);
    expect(fees.count).toBeGreaterThanOrEqual(12);
    expect(k("guardianTerm", DEMO_GUARDIANS.kagiso.wallet).map((x) => [year(x.firstTs), year(x.lastTs)])).toEqual([[2044, 2049]]);
    expect(t.edges.some((e) => e.role === "guardian" && e.to === DEMO_GUARDIANS.kagiso.wallet)).toBe(true);
    expect(k("raisedUpheldChallenge", P.zodwa.address)).toHaveLength(1);
    expect(t.kept.some((x) => x.kind === "challengeUpheld")).toBe(false); // nobody in the story has a negative fact
    expect(k("helpedHardship", P.nomsa.address)[0].for).toEqual([P.sipho.address]);
    expect(k("answeredRequests", P.lerato.address)[0].for).toEqual([STORY_AMAHLE]);
    const cars = t.assets.filter((a) => a.kind === "Car");
    // One journey across three generations: Thabo's plan → Lerato → her own plan → Amahle.
    expect(cars.map((a) => a.steps.map((s) => s.kind))).toEqual([["registered", "heldByPlan", "passedTo", "registered", "heldByPlan", "passedTo"]]);
    expect(cars[0].steps.filter((s) => s.kind === "passedTo").map((s) => s.to)).toEqual([P.lerato.address, STORY_AMAHLE]);
    expect(t.assets.find((a) => a.kind === "Motorbike")!.steps.at(-1)).toMatchObject({ kind: "soldUnderRules", to: P.sipho.address });
  });

  it("links Lerato's own plan (2041) under Thabo's", async () => {
    const t = await tree(service());
    expect(t.generations).toEqual([expect.objectContaining({ childEstate: STORY_ESTATE_LERATO, person: P.lerato.address })]);
    expect(t.generations[0].parentEstate).toBe(person(t, P.thabo.address).ownsEstate);
    expect(year(t.generations[0].ts)).toBe(2041);
    expect(t.edges.filter((e) => e.estate === STORY_ESTATE_LERATO && e.role === "trustedPerson").map((e) => e.to).sort())
      .toEqual([P.sipho.address, P.naledi.address, DEMO_GUARDIANS.priya.wallet].sort());
  });

  it("has a story at every stage of the demo, and after Thabo's passing was played the future follows from it", async () => {
    for (const stage of ["fresh", "unlocked", "guardians", "listed"] as const) {
      const t = await tree(service(stage));
      expect(t.span).toEqual({ from: 1990, to: 2086 });
      expect(t.kept.length).toBeGreaterThan(10);
      expect(findAmounts(t)).toEqual([]);
    }
    const t = await tree(service("unlocked"));
    expect(person(t, P.thabo.address).passed).toBe(thisYear);
    expect(t.kept.find((k) => k.kind === "confirmedPassing" && k.about === P.thabo.address)?.imagined).toBe(false);
  });

  it("looks alive on the slider: more people, lines and kept promises as the years go by", async () => {
    const t = await tree(service());
    const sizes = [1995, 2026, 2041, 2050, 2086].map((y) => treeAtYear(t, y)).map((x) => [x.people.length, x.edges.length, x.kept.length]);
    for (let i = 1; i < sizes.length; i++) for (let j = 0; j < 3; j++) expect(sizes[i][j]).toBeGreaterThanOrEqual(sizes[i - 1][j]);
    expect(sizes[0][1]).toBe(0);
    expect(treeAtYear(t, 2045).people.find((p) => p.id === P.thabo.address)).toMatchObject({ alive: false, passed: 2041 });
  });

  it("never carries an amount", async () => {
    expect(findAmounts(await tree(service()))).toEqual([]);
  });
});

describe("editing the tree in the demo", () => {
  it("lets the owner add and remove relationships (kept with the demo state), and refuses anyone else", async () => {
    const s = service();
    const estate = (await s.listEstatesFor(P.thabo.address))[0].estate;
    act(s, "lerato");
    await expect(s.setRelationship(estate, { kind: "siblingOf", from: P.busi.address, to: P.zodwa.address })).rejects.toThrow(/NotOwner/);
    act(s, "thabo");
    const r = await s.setRelationship(estate, { kind: "siblingOf", from: P.zodwa.address, to: P.busi.address });
    expect(r.id).toBe(relationshipId("siblingOf", P.busi.address, P.zodwa.address));
    await expect(s.setRelationship(estate, { kind: "parentOf", from: P.lerato.address, to: P.thabo.address })).rejects.toThrow(/own grandparent/);
    await expect(s.setRelationship(estate, { kind: "spouseOf", from: P.thabo.address, to: P.thabo.address })).rejects.toThrow(/two different/);

    // Persisted: a new service on the same browser storage sees it.
    const again = createMockService({ instant: true });
    expect((await again.getTree(estate)).relationships.some((x) => x.id === r.id)).toBe(true);

    // Removing a default relationship keeps it removed.
    const kagiso = relationshipId("parentOf", P.busi.address, DEMO_GUARDIANS.kagiso.wallet);
    await s.removeRelationship(estate, kagiso);
    expect((await s.getTree(estate)).relationships.some((x) => x.id === kagiso)).toBe(false);
    await expect(s.removeRelationship(estate, kagiso)).rejects.toThrow(/not on the tree/);
  });

  it("lets a living adult hide themselves: no name, edges kept, fingerprint unchanged", async () => {
    const s = service();
    const estate = (await s.listEstatesFor(P.thabo.address))[0].estate;
    const before = await s.getTree(estate);
    act(s, "zodwa");
    await s.setHidden(estate, true);
    const after = await s.getTree(estate);
    expect(person(after, P.zodwa.address)).toMatchObject({ hidden: true, name: "", short: "" });
    expect(after.edges.some((e) => e.to === P.zodwa.address)).toBe(true);
    expect(after.fingerprint).toBe(before.fingerprint);
    await s.setHidden(estate, false);
    expect(person(await s.getTree(estate), P.zodwa.address)).toMatchObject({ hidden: false, name: "Aunt Zodwa Mokoena" });
  });
});

describe("photos in the demo (plan.md §15.11)", () => {
  const estateOf = async (s: MockService) => (await s.listEstatesFor(P.thabo.address))[0].estate;

  it("starts with the bundled demo faces (served from our own origin): memorial ones for Thabo's parents, a logo for the charity", async () => {
    const t = await tree(service());
    expect(person(t, P.thabo.address).photo).toMatchObject({ src: "/demo/people/thabo.webp", addedBy: P.thabo.address, memorial: false });
    expect(person(t, "local:mkhulu-joseph").photo).toMatchObject({ addedBy: P.thabo.address, memorial: true });
    expect(person(t, "local:gogo-martha").photo).toMatchObject({ addedBy: P.thabo.address, memorial: true });
    expect(person(t, DEMO_GUARDIANS.charity.wallet).photo?.src).toMatch(/^data:image\/svg\+xml/);
    expect(person(t, DEMO_GUARDIANS.kagiso.wallet).photo).toBeUndefined(); // initials, and "Add photo" for Kagiso
    const srcs = t.people.flatMap((p) => (p.photo ? [p.photo.src] : []));
    expect(srcs.length).toBeGreaterThanOrEqual(11);
    // Faces are same-origin files that exist; nothing is linked from elsewhere (the CSP allows img-src 'self' only).
    for (const s of srcs.filter((x) => !x.startsWith("data:"))) {
      expect(s).toMatch(/^\/demo\/people\/[a-z-]+\.webp$/);
      expect(existsSync(join(process.cwd(), "public", s))).toBe(true);
    }
    const svg = srcs.filter((x) => x.startsWith("data:")).map((s) => decodeURIComponent(s.split(",")[1]).replace('xmlns="http://www.w3.org/2000/svg"', "")).join("");
    expect(svg).not.toMatch(/https?:|<image|href/);
  });

  it("lets a living adult set and remove only their own photo; kept with the demo state; fingerprint unchanged", async () => {
    const s = service();
    const estate = await estateOf(s);
    const before = await s.getTree(estate);
    act(s, "zodwa");
    const mine = webpOf(5_000);
    await s.setPhoto(estate, P.zodwa.address, mine);
    const after = await s.getTree(estate);
    expect(person(after, P.zodwa.address).photo).toMatchObject({ src: mine, addedBy: P.zodwa.address, memorial: false });
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(person(await createMockService({ instant: true }).getTree(estate), P.zodwa.address).photo?.src).toBe(mine);
    // Not someone else's, not even a relative's.
    await expect(s.setPhoto(estate, P.lerato.address, mine)).rejects.toThrow(/NotOwner/);
    await expect(s.removePhoto(estate, P.thabo.address)).rejects.toThrow(/NotOwner/);
    // The owner cannot change a living adult's photo either.
    act(s, "thabo");
    await expect(s.setPhoto(estate, P.zodwa.address, webpOf(100))).rejects.toThrow(/NotOwner/);
    act(s, "zodwa");
    await s.removePhoto(estate, P.zodwa.address);
    expect(person(await s.getTree(estate), P.zodwa.address).photo).toBeUndefined();
  });

  it("lets only the owner decide for a child, someone who has passed and the charity", async () => {
    const s = service();
    const estate = await estateOf(s);
    act(s, "lerato");
    await expect(s.setPhoto(estate, P.naledi.address, webpOf(100))).rejects.toThrow(/NotOwner/);
    await expect(s.removePhoto(estate, "local:gogo-martha")).rejects.toThrow(/NotOwner/);
    act(s, "naledi");
    await expect(s.setPhoto(estate, P.naledi.address, webpOf(100))).rejects.toThrow(/NotOwner/);
    act(s, "thabo");
    const pic = webpOf(800);
    await s.setPhoto(estate, P.naledi.address, pic);
    await s.setPhoto(estate, DEMO_GUARDIANS.charity.wallet, pic);
    await s.removePhoto(estate, "local:mkhulu-joseph");
    const t = await s.getTree(estate);
    expect(person(t, P.naledi.address).photo).toMatchObject({ src: pic, memorial: false });
    expect(person(t, DEMO_GUARDIANS.charity.wallet).photo?.src).toBe(pic);
    expect(person(t, "local:mkhulu-joseph").photo).toBeUndefined();
  });

  it("never shows a hidden person's photo, and nobody can set one for them", async () => {
    const s = service();
    const estate = await estateOf(s);
    act(s, "zodwa");
    await s.setPhoto(estate, P.zodwa.address, webpOf(300));
    await s.setHidden(estate, true);
    expect(person(await s.getTree(estate), P.zodwa.address).photo).toBeUndefined();
    await expect(s.setPhoto(estate, P.zodwa.address, webpOf(300))).rejects.toThrow(/hide/);
  });

  it("refuses a photo over 60 KB or not WebP", async () => {
    const s = service();
    const estate = await estateOf(s);
    act(s, "zodwa");
    await expect(s.setPhoto(estate, P.zodwa.address, webpOf(61 * 1024))).rejects.toThrow(/60 KB/);
    await expect(s.setPhoto(estate, P.zodwa.address, "data:image/png;base64,iVBORw0KGgo=")).rejects.toThrow(/WebP/);
  });
});
