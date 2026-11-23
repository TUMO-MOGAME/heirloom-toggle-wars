// Makes the Trust Tree's demo faces (plan.md §15.11) from the Unsplash originals kept locally in media/people/
// (git-ignored; media/people/SOURCES.md says which photo is whose). Each becomes a 256×256 WebP, cropped on the face,
// with no metadata, at app/public/demo/people/<id>.webp. The two grandparents, who have passed, are in black and white.
// Usage (from app/, so sharp resolves): node ../scripts/demo-people-photos.mjs ../media/people
import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "..", "app");
const sharp = createRequire(path.join(app, "package.json"))("sharp");
const src = process.argv[2];
if (!src) { console.error("Give the folder that holds <id>.jpg."); process.exit(1); }
const out = path.join(app, "public", "demo", "people");
mkdirSync(out, { recursive: true });

// The face's square, as fractions of the original: left, top and side (of the shorter edge). Chosen by looking.
const PEOPLE = {
  "mkhulu-joseph": { crop: [0.12, 0.08, 0.72], grey: true },
  "gogo-martha": { crop: [0.18, 0.04, 0.66], grey: true },
  bongani: { crop: [0.08, 0.1, 0.84] },
  thabo: { crop: [0.27, 0.08, 0.46] },
  zodwa: { crop: [0.27, 0.06, 0.78] },
  lerato: { crop: [0.2, 0.13, 0.6] },
  sipho: { crop: [0.1, 0.08, 0.8] },
  naledi: { crop: [0.18, 0.16, 0.64] },
  amahle: { crop: [0.22, 0.07, 0.56] },
  ndlovu: { crop: [0.2, 0.08, 0.6] },
  pillay: { crop: [0.18, 0.12, 0.6] },
  priya: { crop: [0.32, 0.1, 0.4] },
};

for (const [id, { crop: [l, t, s], grey }] of Object.entries(PEOPLE)) {
  const file = path.join(src, `${id}.jpg`);
  const img = sharp(file).rotate(); // apply EXIF orientation, then drop all metadata on output
  const { width, height } = await img.metadata();
  const side = Math.round(Math.min(width, height) * s);
  const left = Math.min(Math.round(width * l), width - side);
  const top = Math.min(Math.round(height * t), height - side);
  let p = img.extract({ left, top, width: side, height: side }).resize(256, 256);
  if (grey) p = p.grayscale();
  const dest = path.join(out, `${id}.webp`);
  await p.webp({ quality: 78 }).toFile(dest);
  console.log(id, `${(statSync(dest).size / 1024).toFixed(1)} KB`);
}
