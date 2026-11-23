// Converts the dealer's AVIF photos of Thabo's two demo assets to WebP (long edge ≤ 1600 px, quality 82, no
// metadata) and writes:
//   app/public/demo/assets/<slug>/<nn>-<label>.webp      the photos, served from our own origin
//   app/src/lib/service/demo-asset-photos.ts             sha256 / size / label of each, for the mock seed
// Usage (from app/, so sharp resolves): node ../scripts/demo-asset-photos.mjs ../media/vehicles   (the .avif originals, kept locally)
// Tumo confirmed on 15 Nov 2026 that these photos may be published.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "..", "app");
const sharp = createRequire(path.join(app, "package.json"))("sharp");
const src = process.argv[2];
if (!src) { console.error("Give the folder that holds the .avif files."); process.exit(1); }

// Photo order = the dealer's order; labels chosen by looking at each photo. The first photo is the cover.
const SETS = [
  {
    key: "corolla", slug: "corolla-2017", prefix: "35CC146",
    labels: ["Front", "Front", "Front", "Side", "Rear", "Side", "Interior", "Dashboard", "Interior", "Wheels", "Interior", "Interior", "Interior", "Dashboard", "Engine", "Boot"],
  },
  {
    key: "mustang", slug: "mustang-250-2025", prefix: "8DC00392",
    labels: ["Front", "Side", "Side", "Dashboard", "Engine", "Engine", "Other", "Other", "Rear"],
  },
];

const out = {};
for (const set of SETS) {
  const files = readdirSync(src)
    .filter((f) => f.startsWith(set.prefix) && f.toLowerCase().endsWith(".avif"))
    .sort((a, b) => Number(a.slice(set.prefix.length, -5)) - Number(b.slice(set.prefix.length, -5)));
  if (files.length !== set.labels.length) throw new Error(`${set.key}: expected ${set.labels.length} photos, found ${files.length}`);
  const dir = path.join(app, "public", "demo", "assets", set.slug);
  mkdirSync(dir, { recursive: true });
  out[set.key] = [];
  for (const [i, f] of files.entries()) {
    const { data, info } = await sharp(path.join(src, f))
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const name = `${String(i + 1).padStart(2, "0")}-${set.labels[i].toLowerCase()}.webp`;
    writeFileSync(path.join(dir, name), data);
    out[set.key].push({
      sha256: createHash("sha256").update(data).digest("hex"), url: `/demo/assets/${set.slug}/${name}`,
      width: info.width, height: info.height, bytes: data.length, label: set.labels[i],
    });
    console.log(set.key, name, `${info.width}x${info.height}`, `${Math.round(data.length / 1024)} KB`);
  }
}

// Spec sheets (Tumo, 14 Nov 2026). The dealer's stock numbers, branch and inspector's name are left out on purpose.
const SPECS = {
  corolla: {
    title: "2017 Toyota Corolla 1.8 Exclusive CVT", kind: "Car",
    spec: {
      mileageKm: 124455, driveType: "4x2", transmission: "Automatic", fuel: "Petrol", consumptionL100: 6.4, engineCc: 1798,
      make: "Toyota", model: "Corolla", variant: "1.8 Exclusive CVT", year: 2017, bodyType: "Sedan", colour: "Silver", seats: 5, doors: 4,
      serviceHistory: "Partial", conditionCategory: "A", spareKey: false,
      roadworthyNotes: "Has faults that must be repaired before it can pass a roadworthy test and be driven legally.",
      zeroTo100S: 10.2, topSpeedKmh: 195, powerKw: 103, fuelTankL: 55, cylinderLayout: "I4", gears: 6, drive: "FWD",
    },
  },
  mustang: {
    title: "2025 Big Boy Mustang 250", kind: "Motorbike",
    spec: {
      mileageKm: 199, transmission: "Manual", fuel: "Petrol", engineCc: 250,
      make: "Big Boy", model: "Mustang", variant: "250", year: 2025, bodyType: "Road bike", colour: "Black", seats: 2,
      serviceHistory: "None", conditionCategory: "A", spareKey: false,
      powerKw: 11, fuelTankL: 13, cylinderLayout: "I1", gears: 5, drive: "RWD",
    },
  },
};

// Same rule as app/src/lib/assets/spec.ts mediaRootHex (a vitest test checks the two agree).
const LABELS = ["Front", "Rear", "Side", "Interior", "Dashboard", "Engine", "Boot", "Wheels", "Damage", "Other"];
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])])) : v;
const sha = (b) => createHash("sha256").update(b).digest();
function mediaRoot(photos, spec) {
  const specHash = sha(JSON.stringify(sortKeys(spec)));
  return sha(Buffer.concat([
    Buffer.from([2]), ...photos.map((p) => Buffer.from(p.sha256, "hex")),
    Buffer.from(photos.map((p) => LABELS.indexOf(p.label))), specHash,
  ])).toString("hex");
}

const assets = Object.fromEntries(Object.entries(SPECS).map(([k, v]) => [k, { ...v, photos: out[k], mediaRoot: mediaRoot(out[k], v.spec) }]));

const ts = `/**
 * GENERATED by scripts/demo-asset-photos.mjs: do not edit by hand. Thabo's two demo assets: photos (WebP, served
 * from app/public/demo/assets/; published with Tumo's permission, 15 Nov 2026), spec sheets and media roots.
 */
import type { AssetKind, AssetPhoto } from "../guardians/types";
import type { AssetSpec } from "../assets/spec";

export interface DemoAsset { title: string; kind: AssetKind; spec: AssetSpec; photos: AssetPhoto[]; mediaRoot: string }

export const DEMO_ASSETS: Record<"corolla" | "mustang", DemoAsset> = ${JSON.stringify(assets, null, 2)};
`;
writeFileSync(path.join(app, "src", "lib", "service", "demo-asset-photos.ts"), ts);
console.log("wrote demo-asset-photos.ts");
