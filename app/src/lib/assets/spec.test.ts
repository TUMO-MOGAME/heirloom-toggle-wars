/** Spec sheets, photo labels and the media root (lib/assets/spec.ts), plus the generated demo assets. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleanSpec, EMPTY_MEDIA_ROOT, groupByLabel, hasSpec, isPhotoLabel, mediaRootHex, PHOTO_LABELS, foreignSpecKeys, SPEC_LAYOUTS, specHashHex, specKeysFor, type AssetSpec } from "./spec";
import { parseSpec, specSchema } from "./spec-schema";
import { DEMO_ASSETS } from "../service/demo-asset-photos";
import { MAX_PHOTOS } from "../media/webp";

const h = (c: string) => c.repeat(64);

describe("spec sheet schema", () => {
  it("accepts a full vehicle sheet and every field is optional", () => {
    expect(specSchema.parse(DEMO_ASSETS.corolla.spec)).toEqual(DEMO_ASSETS.corolla.spec);
    expect(specSchema.parse({})).toEqual({});
  });

  it("refuses values out of range, wrong enums, unknown keys and too much text", () => {
    const bad: unknown[] = [
      { year: 1899 }, { year: 2101 }, { mileageKm: -1 }, { mileageKm: 1.5 }, { seats: 0 }, { doors: 11 }, { gears: 13 },
      { consumptionL100: 6.45 }, { zeroTo100S: 61 }, { topSpeedKmh: 501 }, { transmission: "CVT" }, { fuel: "Coal" },
      { serviceHistory: "Some" }, { conditionCategory: "E" }, { drive: "Front" }, { spareKey: "no" }, { make: "" },
      { roadworthyNotes: "x".repeat(401) }, { colour: "Silver", owner: "Thabo" },
    ];
    for (const b of bad) expect(specSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("accepts one decimal for consumption and 0–100 times", () => {
    expect(specSchema.safeParse({ consumptionL100: 6.4, zeroTo100S: 10.2 }).success).toBe(true);
  });

  it("cleanSpec drops blanks and returns undefined for an empty sheet", () => {
    expect(cleanSpec({ make: "  Toyota ", colour: "" as never })).toEqual({ make: "Toyota" });
    expect(cleanSpec({})).toBeUndefined();
    expect(cleanSpec(undefined)).toBeUndefined();
    expect(hasSpec({ spareKey: false })).toBe(true); // "no spare key" is information, not a blank
    expect(parseSpec(null)).toBeUndefined();
    expect(() => parseSpec({ year: "2017" })).toThrow();
  });

  it("gives every kind its own sheet: no field twice on a sheet, and every field on some sheet", () => {
    for (const kind of Object.keys(SPEC_LAYOUTS) as (keyof typeof SPEC_LAYOUTS)[]) {
      const keys = specKeysFor(kind);
      expect(new Set(keys).size, kind).toBe(keys.length);
      expect(keys.length, kind).toBeGreaterThan(5);
    }
    const all = new Set(Object.keys(SPEC_LAYOUTS).flatMap((k) => specKeysFor(k as keyof typeof SPEC_LAYOUTS)));
    expect([...all].sort()).toEqual(Object.keys(specSchema.shape).sort());
    expect(SPEC_LAYOUTS.Jewellery.performance).toBeUndefined();
  });

  it("finds details that do not belong on a kind's sheet", () => {
    expect(foreignSpecKeys("Car", DEMO_ASSETS.corolla.spec)).toEqual([]);
    expect(foreignSpecKeys("Jewellery", { metal: "Yellow gold", purity: "18 ct", weightG: 4.2, certificate: true })).toEqual([]);
    expect(foreignSpecKeys("Jewellery", { metal: "Gold", mileageKm: 10 })).toEqual(["mileageKm"]);
    expect(foreignSpecKeys("Furniture", { material: "Oak", doors: 2 })).toEqual(["doors"]);
    expect(foreignSpecKeys("Other", undefined)).toEqual([]);
  });
});

describe("media root", () => {
  const spec: AssetSpec = { make: "Toyota", year: 2017 };

  it("is zero with no photos and no spec sheet", async () => {
    expect(await mediaRootHex([])).toBe(EMPTY_MEDIA_ROOT);
    expect(await mediaRootHex([], {})).toBe(EMPTY_MEDIA_ROOT);
    expect(await specHashHex(undefined)).toBe(EMPTY_MEDIA_ROOT);
  });

  it("changes with the photo order, any label and any spec value", async () => {
    const base = await mediaRootHex([{ sha256: h("a"), label: "Front" }, { sha256: h("b"), label: "Engine" }], spec);
    const variants = await Promise.all([
      mediaRootHex([{ sha256: h("b"), label: "Engine" }, { sha256: h("a"), label: "Front" }], spec),
      mediaRootHex([{ sha256: h("a"), label: "Rear" }, { sha256: h("b"), label: "Engine" }], spec),
      mediaRootHex([{ sha256: h("a") }, { sha256: h("b"), label: "Engine" }], spec),
      mediaRootHex([{ sha256: h("a"), label: "Front" }, { sha256: h("b"), label: "Engine" }], { ...spec, year: 2018 }),
      mediaRootHex([{ sha256: h("a"), label: "Front" }, { sha256: h("b"), label: "Engine" }]),
      mediaRootHex([{ sha256: h("a"), label: "Front" }], spec),
    ]);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("does not depend on the order of the spec's keys", async () => {
    expect(await specHashHex({ make: "Toyota", year: 2017 })).toBe(await specHashHex({ year: 2017, make: "Toyota" }));
  });

  it("matches the rule written out byte by byte", async () => {
    const photos = [{ sha256: h("1"), label: "Boot" as const }, { sha256: h("2") }];
    const specHash = Buffer.from(createHash("sha256").update(JSON.stringify({ make: "Toyota", year: 2017 })).digest());
    const bytes = Buffer.concat([Buffer.from([2]), Buffer.from(h("1"), "hex"), Buffer.from(h("2"), "hex"), Buffer.from([6, 0xff]), specHash]);
    expect(await mediaRootHex(photos, spec)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("refuses a malformed photo hash", async () => {
    await expect(mediaRootHex([{ sha256: "abc" }])).rejects.toThrow(/SHA-256/);
  });
});

describe("photo labels and gallery groups", () => {
  it("knows the ten labels", () => {
    expect(PHOTO_LABELS).toHaveLength(10);
    expect(isPhotoLabel("Engine")).toBe(true);
    expect(isPhotoLabel("Roof")).toBe(false);
  });

  it("groups in label order, keeps each photo's index and counts unlabelled photos as Other", () => {
    const groups = groupByLabel([{ label: "Engine" as const }, {}, { label: "Front" as const }, { label: "Engine" as const }]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.index)])).toEqual([["Front", [2]], ["Engine", [0, 3]], ["Other", [1]]]);
  });
});

describe("generated demo assets (scripts/demo-asset-photos.mjs)", () => {
  it.each(Object.entries(DEMO_ASSETS))("%s: valid spec, labelled WebP photos within the limit, root matches", async (_k, a) => {
    expect(specSchema.safeParse(a.spec).success).toBe(true);
    expect(a.photos.length).toBeLessThanOrEqual(MAX_PHOTOS);
    expect(a.photos.every((p) => isPhotoLabel(p.label))).toBe(true);
    expect(a.photos[0].label).toBe("Front"); // the cover
    expect(await mediaRootHex(a.photos, a.spec)).toBe(a.mediaRoot);
    for (const p of a.photos) {
      const file = path.join(process.cwd(), "public", p.url);
      expect(existsSync(file), p.url).toBe(true);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(p.sha256);
    }
  });

  it("has Thabo's two assets as described, without the dealer's details", () => {
    expect(DEMO_ASSETS.corolla.photos).toHaveLength(16);
    expect(DEMO_ASSETS.mustang.photos).toHaveLength(9);
    expect(DEMO_ASSETS.corolla.spec).toMatchObject({ mileageKm: 124455, engineCc: 1798, drive: "FWD", serviceHistory: "Partial", spareKey: false });
    expect(DEMO_ASSETS.mustang.spec).toMatchObject({ mileageKm: 199, engineCc: 250, drive: "RWD", serviceHistory: "None", gears: 5 });
    const text = JSON.stringify(DEMO_ASSETS).toLowerCase();
    for (const word of ["dekra", "stock", "branch", "webuycars"]) expect(text).not.toContain(word);
  });
});
