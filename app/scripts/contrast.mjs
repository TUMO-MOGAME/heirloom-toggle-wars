#!/usr/bin/env node
/**
 * Palette guard + WCAG 2.1 contrast check for Heirloom's design (black / white, amber accent, green "ok").
 *
 *   node scripts/contrast.mjs [--md]
 *
 * It fails (exit 1) when any of these is true:
 *  1. A text / background / UI pair in src/app/globals.css is below its target (4.5 for text, 3 for large text,
 *     icons, control boundaries and focus rings), in the night theme (the default), the day theme, the inverted
 *     strip, or the inverted .brand-panel (which must hold exactly the other theme's tokens).
 *  2. The duplicated token blocks drift apart: day ([data-theme=light]) vs day (system on a light device), and each
 *     .brand-panel block vs the opposite theme; or a theme's --underline isn't drawn in that theme's --amber.
 *  3. A colour outside the palette appears: any hue except the amber and green families below (and those only as
 *     tokens in globals.css: components use tokens, never literals), any hsl / oklch / lab / color-mix colour, a
 *     Tailwind palette utility (text-red-500, bg-amber-200 ...), or a hue in the icon / social PNGs.
 *  4. The word "gradient" appears anywhere in src/ or public/ (CSS, Tailwind classes, SVG).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS_FILE = path.join(root, "src/app/globals.css");
const css = fs.readFileSync(CSS_FILE, "utf8").replace(/\r\n/g, "\n");
const problems = [];

/** The only hues allowed, and only as tokens in globals.css. */
const HUES = {
  c25e12: "amber (day: large text, icons, underline)",
  "9c4a12": "amber ink (day: small text, focus)",
  f0a35e: "amber (night)",
  "2f6b4f": "ok green (day)",
  e6f2eb: "ok soft (day)",
  "6fcf9a": "ok green (night)",
  "0f2a1d": "ok soft (night)",
};

/* ---------- 1. token blocks ---------- */
const blockAt = (at) => {
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const block = (selector) => {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`globals.css: missing ${selector}`);
  return blockAt(at);
};
const COLOUR_KEY = /^--(bg|surface|ink|line|accent|amber|on-amber|danger|ok|focus|strip|scrim|shadow|underline)/;
const colours = (b) => Object.fromEntries(Object.entries(b).filter(([k]) => COLOUR_KEY.test(k)));
const dark = colours(block(":root {"));
const light = colours(block(':root[data-theme="light"] {'));
const same = (a, b, what) => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) problems.push(`token blocks differ: ${what} on ${k} (${a[k]} vs ${b[k]})`);
};
same(light, colours(block(':root[data-theme="system"] {')), "day ([data-theme=light]) vs day (system, light device)");
same(light, colours(block("\n.brand-panel {")), "inverted panel on the night page vs day tokens");
same(dark, colours(block(':root[data-theme="light"] .brand-panel {')), "inverted panel on the day page vs night tokens");
same(dark, colours(block(':root[data-theme="system"] .brand-panel {')), "inverted panel (system, light device) vs night tokens");
for (const [name, t] of [["night", dark], ["day", light]]) {
  const amber = (t["--amber"] ?? "").replace("#", "").toLowerCase();
  if (!(t["--underline"] ?? "").toLowerCase().includes(`%23${amber}`)) problems.push(`${name}: --underline is not drawn in --amber (#${amber})`);
}

/* ---------- 2. contrast ---------- */
const resolve = (t, v) => { let x = v; for (let i = 0; i < 8 && x?.startsWith("var("); i++) x = t[x.slice(4, -1).trim()]; return x; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => { const [r, g, b] = rgb(hex).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum, what it is]
const T = 4.5, L = 3;
const pairs = [
  ["ink", "bg", T, "Body text on page"],
  ["ink", "surface", T, "Body text on card"],
  ["ink", "surface-2", T, "Body text on soft fill (chips, bubbles)"],
  ["ink", "accent-soft", T, "Text on selected tint"],
  ["ink", "ok-soft", T, "Text on success panel"],
  ["ink-2", "bg", T, "Secondary text on page"],
  ["ink-2", "surface", T, "Secondary text on card"],
  ["ink-2", "surface-2", T, "Secondary text on soft fill"],
  ["ink-2", "accent-soft", T, "Secondary text on selected tint"],
  ["ink-2", "ok-soft", T, "Secondary text on success panel"],
  ["bg", "ink", T, "Primary button label / inverted chip (page colour on ink)"],
  ["bg", "ink-hover", T, "Primary button label (hover)"],
  ["ink", "bg", L, "Primary button shape against page"],
  ["ink-hover", "bg", L, "Primary button shape against page (hover)"],
  ["accent", "bg", T, "Link / accent text on page"],
  ["accent", "surface-2", T, "Accent text on soft fill"],
  ["accent", "accent-soft", T, "Accent text on selected tint"],
  ["amber-ink", "bg", T, "Small accent text (eyebrow, link) on page"],
  ["amber-ink", "surface-2", T, "Small accent text on soft fill (tag)"],
  ["amber", "bg", L, "Accent icon / big number / underline on page"],
  ["amber", "surface-2", L, "Accent icon on soft tile; meter fill on its track"],
  ["accent", "bg", L, "Selected outline against page"],
  ["accent", "line", L, "Step / progress fill against its empty track"],
  ["accent-ink", "accent", T, "Text on accent fill"],
  ["on-amber", "amber", L, "Large text / icon on amber fill (small text on a fill uses --accent + --accent-ink)"],
  ["ok", "bg", T, "Success text on page"],
  ["ok", "ok-soft", T, "Success pill text"],
  ["ok-soft", "ok", L, "Tick knocked out of the green disc"],
  ["danger", "bg", T, "Danger text on page"],
  ["line-strong", "bg", L, "Control border on page"],
  ["line-strong", "surface", L, "Input / control border on card"],
  ["line-strong", "surface-2", L, "Control border on soft fill"],
  ["focus", "bg", L, "Focus ring on page"],
  ["focus", "surface", L, "Focus ring on card"],
  ["focus", "surface-2", L, "Focus ring on soft fill"],
  ["focus", "ok-soft", L, "Focus ring on success panel"],
  ["strip-ink", "strip", T, "Inverted strip: text"],
  ["ink-2-inv", "strip", T, "Inverted strip: secondary text"],
  ["amber-inv", "strip", L, "Inverted strip: accent icon / large text"],
];

const rows = [];
// The inverted .brand-panel holds the other theme's tokens (checked above), so checking both themes covers it.
for (const [name, t] of [["night", dark], ["day", light]]) {
  const get = (k) => {
    const v = resolve(t, t[`--${k}`]);
    if (!/^#[0-9a-f]{6}$/i.test(v ?? "")) throw new Error(`${name}: --${k} is not a 6-digit hex colour (${v})`);
    return v;
  };
  for (const [fg, bg, min, what] of pairs) {
    const r = ratio(get(fg), get(bg));
    const ok = r >= min;
    if (!ok) problems.push(`contrast ${name}: ${what} is ${r.toFixed(2)} (needs ${min})`);
    rows.push({ theme: name, what, fg: `${fg} ${get(fg)}`, bg: `${bg} ${get(bg)}`, ratio: r.toFixed(2), min, ok });
  }
}

/* ---------- 3 + 4. palette only, no blends, anywhere ---------- */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const TEXT = /\.(css|tsx?|mjs|js|json|svg|txt|html)$/;
const files = [...walk(path.join(root, "src")), ...walk(path.join(root, "public"))];
const rel = (p) => path.relative(root, p).replace(/\\/g, "/");
const PALETTE = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|stone";
const UTIL = "text|bg|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder";
const paletteRe = new RegExp(`(?<![\\w-])(?:${UTIL})-(?:[lrtbxyse]-)?(?:${PALETTE})-\\d{2,3}\\b`, "g");
let scanned = 0, literals = 0;
for (const file of files) {
  if (!TEXT.test(file) || /\.test\.tsx?$/.test(file) || file.includes(`${path.sep}idl${path.sep}`)) continue;
  scanned++;
  const tokens = file === CSS_FILE;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = `${rel(file)}:${i + 1}`;
    if (/gradient/i.test(line)) problems.push(`gradient: ${at}  ${line.trim().slice(0, 100)}`);
    if (/\b(hsla?|hwb|oklch|oklab|lab|lch|color-mix|color|light-dark)\(/i.test(line)) problems.push(`non-palette colour function: ${at}  ${line.trim().slice(0, 100)}`);
    for (const m of line.matchAll(/(?<![\w&/])#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi)) {
      literals++;
      const h = (m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1]).toLowerCase();
      const [r, g, b] = [0, 2, 4].map((j) => parseInt(h.slice(j, j + 2), 16));
      if (r === g && g === b) continue;
      if (!HUES[h.slice(0, 6)]) problems.push(`hue outside the palette #${m[1]}: ${at}`);
      else if (!tokens) problems.push(`palette colour #${m[1]} hard-coded outside globals.css (use a token): ${at}`);
    }
    for (const m of line.matchAll(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/gi)) {
      literals++;
      if (m[1] !== m[2] || m[2] !== m[3]) problems.push(`hue in ${m[0]}): ${at}`);
    }
    for (const m of line.matchAll(paletteRe)) problems.push(`Tailwind palette colour ${m[0]}: ${at}`);
  });
}

// Raster assets: every pixel must be neutral (allowing 2 levels of antialiasing error).
let pngs = 0;
try {
  const sharp = createRequire(import.meta.url)("sharp");
  for (const file of files.filter((f) => f.endsWith(".png"))) {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let worst = 0;
    for (let i = 0; i < data.length; i += info.channels) worst = Math.max(worst, Math.abs(data[i] - data[i + 1]), Math.abs(data[i + 1] - data[i + 2]));
    pngs++;
    if (worst > 2) problems.push(`hue in image ${rel(file)} (channel spread ${worst})`);
  }
} catch (e) {
  console.warn(`(skipped PNG hue check: ${e.message.split("\n")[0]})`);
}

/* ---------- report ---------- */
const md = process.argv.includes("--md");
if (md) {
  console.log("| Theme | Pair | Foreground | Background | Ratio | Min | |\n|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.theme} | ${r.what} | ${r.fg} | ${r.bg} | ${r.ratio} | ${r.min} | ${r.ok ? "pass" : "FAIL"} |`);
} else {
  for (const r of rows) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.theme.padEnd(5)} ${r.ratio.padStart(5)} (min ${r.min})  ${r.what}  [${r.fg} on ${r.bg}]`);
}
console.log(`\n${rows.length} contrast pairs checked (night, day; the strip and the inverted panel included). ${scanned} text files scanned (${literals} colour literals), ${pngs} PNGs checked.`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  FAIL  ${p}`);
  process.exit(1);
}
console.log("Palette: neutrals plus the amber and green tokens only, no gradient, all token blocks in step. All pairs pass.");
