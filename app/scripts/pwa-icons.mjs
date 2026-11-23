/**
 * Builds the maskable app icons from public/icons/icon.svg with sharp.
 * Run: node scripts/pwa-icons.mjs (from app/).
 *
 * A maskable icon is cut by the phone into a circle, squircle or rounded square, so it must be full-bleed (no
 * transparent corners) with everything that matters inside the central 80% "safe zone" (W3C manifest spec).
 * Background = the icon's own black (--ink in light mode, the brand mark), glyph = white, scaled so the whole
 * glyph sits inside a circle of 72% of the canvas: on-brand and never clipped, whatever mask the launcher uses.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = await readFile(path.join(root, "public/icons/icon.svg"), "utf8");

// Keep the glyph (the <g>), drop the rounded tile: the launcher's mask is the tile now.
const glyph = svg.match(/<g[\s\S]*<\/g>/)?.[0];
if (!glyph) throw new Error("icon.svg: no <g> glyph found");

// In icon.svg the glyph spans about x 12.5..35.5, y 7.9..39.5 of a 48 box (centre ~ 24, 23.7; height ~ 31.6).
// Scale it so its height is 54% of the canvas (its diagonal then stays well inside the 80% safe zone), centred.
const BOX = 48, GLYPH_H = 31.6, GLYPH_CY = 23.7, TARGET = 0.54;
const scale = (TARGET * BOX) / GLYPH_H;
const tx = BOX / 2 - 24 * scale, ty = BOX / 2 - GLYPH_CY * scale;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}"><rect width="${BOX}" height="${BOX}" fill="#000000"/><g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})">${glyph}</g></svg>`;

for (const size of [192, 512]) {
  const out = path.join(root, `public/icons/icon-maskable-${size}.png`);
  await sharp(Buffer.from(maskable), { density: (72 * size) / BOX }).resize(size, size).flatten({ background: "#000000" }).png({ compressionLevel: 9 }).toFile(out);
  console.log(`[pwa-icons] ${path.relative(root, out)}`);
}
