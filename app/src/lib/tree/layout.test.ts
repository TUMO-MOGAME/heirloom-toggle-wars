import { describe, expect, it } from "vitest";
import { NODE_R, familyLines, initials, layoutTree, pointOnCubic, strokeFor, trustCurves } from "./layout";
import { treeFixture, FIXTURE_IDS as ID } from "./fixture";
import { treeAtYear } from "./timeline";

const t = treeFixture("EST");

describe("layoutTree", () => {
  const at = treeAtYear(t, 2041);
  const l = layoutTree(at.people, at.relationships, { width: 1100 });
  const x = (id: string) => l.nodes.get(id)!.x;

  it("puts generations in rows, oldest at the top", () => {
    expect(l.rows.map((r) => r.generation)).toEqual([0, 1, 2, 3]);
    expect(l.nodes.get(ID.JOSEPH)!.y).toBeLessThan(l.nodes.get(ID.THABO)!.y);
    expect(l.nodes.get(ID.THABO)!.y).toBeLessThan(l.nodes.get(ID.LERATO)!.y);
    expect(l.nodes.get(ID.LERATO)!.y).toBeLessThan(l.nodes.get(ID.AMAHLE)!.y);
  });

  it("orders siblings by birth year and keeps spouses side by side", () => {
    expect(x(ID.BONGANI)).toBeLessThan(x(ID.THABO));
    expect(x(ID.THABO)).toBeLessThan(x(ID.ZODWA));
    expect(x(ID.LERATO)).toBeLessThan(x(ID.SIPHO));
    expect(x(ID.SIPHO)).toBeLessThan(x(ID.NALEDI));
    const row1 = [...l.nodes.values()].filter((n) => n.generation === 1).sort((a, b) => a.x - b.x).map((n) => n.id);
    expect(row1.indexOf("local:mpho-mokoena")).toBe(row1.indexOf(ID.THABO) + 1);
  });

  it("puts people with no family line at the end of their row, after a wider gap", () => {
    expect(l.nodes.get(ID.NDLOVU)!.outside).toBe(true);
    expect(x(ID.NDLOVU)).toBeGreaterThan(x(ID.ZODWA));
    expect(l.outsideStart.get(1)).toBe(Math.min(...[...l.nodes.values()].filter((n) => n.outside).map((n) => n.x)));
  });

  it("stays inside the width, centred, and shrinks the gap to fit", () => {
    for (const w of [720, 900, 1400]) {
      const n = layoutTree(at.people, at.relationships, { width: w });
      for (const p of n.nodes.values()) {
        expect(p.x - NODE_R).toBeGreaterThanOrEqual(0);
        expect(p.x + NODE_R).toBeLessThanOrEqual(w);
      }
    }
  });

  it("only lays out who is on the tree at that year", () => {
    const early = treeAtYear(t, 2000);
    const e = layoutTree(early.people, early.relationships, { width: 900 });
    expect(e.nodes.has(ID.AMAHLE)).toBe(false);
    expect(e.nodes.has(ID.KAGISO)).toBe(true);
    expect(e.rows).toHaveLength(3);
  });
});

describe("lines", () => {
  const at = treeAtYear(t, 2034);
  const l = layoutTree(at.people, at.relationships, { width: 1100 });

  it("fans out several trust lines between the same two people", () => {
    const c = trustCurves(at.edges, l).filter((x) => x.edge.from === ID.THABO && x.edge.to === ID.BONGANI);
    expect(c.length).toBe(2);
    expect(c[0].d).not.toBe(c[1].d);
    for (const x of c) expect(x.d).toMatch(/^M [\d.-]+ [\d.-]+ C( [\d.-]+){6}$/);
  });

  it("starts and ends a curve at the two people", () => {
    const [c] = trustCurves(at.edges.filter((e) => e.to === ID.LERATO), l);
    expect(pointOnCubic(c.pts, 0)).toEqual([l.nodes.get(ID.THABO)!.x, l.nodes.get(ID.THABO)!.y]);
    const end = pointOnCubic(c.pts, 1);
    expect(end[0]).toBeCloseTo(l.nodes.get(ID.LERATO)!.x);
  });

  it("draws spouses and one elbow per set of parents", () => {
    const lines = familyLines(at.relationships, l);
    expect(lines.filter((x) => x.kind === "spouse").length).toBeGreaterThanOrEqual(2);
    const parents = lines.filter((x) => x.kind === "parent");
    // Joseph+Martha → 3 children, Thabo+Mpho → 3, Bongani → Kagiso.
    expect(parents).toHaveLength(3);
  });

  it("thickens with kept promises, within limits", () => {
    expect(strokeFor(0)).toBe(1.5);
    expect(strokeFor(5)).toBeGreaterThan(strokeFor(1));
    expect(strokeFor(10_000)).toBeLessThanOrEqual(6);
  });
});

describe("initials", () => {
  it("skips titles and uses first and last names", () => {
    expect(initials("Thabo Mokoena")).toBe("TM");
    expect(initials("Uncle Bongani Mokoena")).toBe("BM");
    expect(initials("Adv. Thandi Ndlovu")).toBe("TN");
    expect(initials("Naledi")).toBe("N");
    expect(initials("")).toBe("");
  });
});

describe("treeAtYear (local stand-in)", () => {
  it("adds people, passings, edges, kept promises and asset steps as the years go by", () => {
    const a = treeAtYear(t, 2026), b = treeAtYear(t, 2040);
    expect(a.people.find((p) => p.id === ID.THABO)!.alive).toBe(true);
    expect(b.people.find((p) => p.id === ID.THABO)!.alive).toBe(false);
    expect(b.kept.length).toBeGreaterThan(a.kept.length);
    const corolla = (y: typeof a) => y.assets.find((x) => x.id === "asset-corolla")!.steps.map((s) => s.kind);
    expect(corolla(a)).toEqual(["registered", "heldByPlan"]);
    expect(corolla(b)).toContain("passedTo");
    expect(treeAtYear(t, 1990).edges).toHaveLength(0);
  });
});
