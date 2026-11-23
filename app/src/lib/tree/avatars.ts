/**
 * Illustrated avatars for the demo family (plan.md §15.11): simple flat drawings made here as SVG data URLs, so the
 * demo tree shows faces out of the box. Never real people's photos and never fetched from the internet. Only the
 * mock service imports this (inside the tree's own chunk).
 *
 * Backgrounds and clothes use the app's token colours (amber, ok green, accent, surface-2 and ok-soft, as hex: an
 * image cannot read CSS variables); memorial drawings (people who have passed) are drawn in warm sepia, like an old
 * print.
 */

export type Hair = "short" | "crop" | "bun" | "long" | "wrap" | "bald" | "curls";

export interface AvatarLook {
  skin: string;
  hair: Hair;
  hairColor: string;
  bg: string;
  shirt: string;
  glasses?: boolean;
  beard?: boolean;
  /** Sepia, for someone who has passed. */
  memorial?: boolean;
}

/** Token colours (globals.css), as hex. */
export const AVATAR_COLORS = {
  amber: "#f0a35e", amberDeep: "#c25e12", ok: "#6fcf9a", okDeep: "#2f6b4f", okSoft: "#e6f2eb",
  accent: "#9c4a12", surface2: "#f3f3f3", ink: "#111111", ink2: "#555555",
} as const;

const SKIN = { a: "#8d5524", b: "#a0663a", c: "#c68642", d: "#6b4226", e: "#e0ac69" } as const;
export { SKIN as AVATAR_SKIN };

const SEPIA = { bg: "#efe3cf", skin: "#b08b62", hair: "#5b4630", shirt: "#8a6e4b", line: "#3d2f20" };

function hairShape(h: Hair, c: string): string {
  switch (h) {
    case "short": return `<path d="M78 118c-4-40 22-66 50-66s54 26 50 66c-8-22-26-34-50-34s-42 12-50 34z" fill="${c}"/>`;
    case "crop": return `<path d="M82 112c0-34 20-54 46-54s46 20 46 54c-10-16-26-24-46-24s-36 8-46 24z" fill="${c}"/>`;
    case "bun": return `<circle cx="128" cy="50" r="22" fill="${c}"/><path d="M76 124c-6-44 20-70 52-70s58 26 52 70c-6-26-26-40-52-40s-46 14-52 40z" fill="${c}"/>`;
    case "long": return `<path d="M70 196c-12-40-14-80-4-104 10-26 34-40 62-40s52 14 62 40c10 24 8 64-4 104h-18c6-30 8-60 2-80-10-16-24-24-42-24s-32 8-42 24c-6 20-4 50 2 80z" fill="${c}"/>`;
    case "wrap": return `<path d="M74 118c-6-50 22-78 54-78s60 28 54 78c-10-18-30-28-54-28s-44 10-54 28z" fill="${c}"/><path d="M150 52c18-8 34 4 32 18-10-8-22-10-32-6z" fill="${c}"/>`;
    case "curls": return `<g fill="${c}">${[[86, 98], [98, 76], [118, 64], [140, 64], [160, 76], [172, 98], [80, 120], [176, 120]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="18"/>`).join("")}</g>`;
    case "bald": return "";
  }
}

/** One avatar as SVG markup (256×256). */
export function avatarSvg(look: AvatarLook): string {
  const m = !!look.memorial;
  const skin = m ? SEPIA.skin : look.skin;
  const hair = m ? SEPIA.hair : look.hairColor;
  const bg = m ? SEPIA.bg : look.bg;
  const shirt = m ? SEPIA.shirt : look.shirt;
  const line = m ? SEPIA.line : "#2b1d14";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`,
    `<rect width="256" height="256" fill="${bg}"/>`,
    // Shoulders and neck.
    `<path d="M40 256c4-48 40-72 88-72s84 24 88 72z" fill="${shirt}"/>`,
    `<rect x="112" y="150" width="32" height="40" rx="12" fill="${skin}"/>`,
    look.hair === "long" ? hairShape("long", hair) : "",
    // Face and ears.
    `<circle cx="80" cy="124" r="10" fill="${skin}"/><circle cx="176" cy="124" r="10" fill="${skin}"/>`,
    `<ellipse cx="128" cy="118" rx="48" ry="54" fill="${skin}"/>`,
    look.hair === "long" ? `<path d="M80 110c4-30 24-46 48-46s44 16 48 46c-12-14-28-22-48-22s-36 8-48 22z" fill="${hair}"/>` : hairShape(look.hair, hair),
    look.beard ? `<path d="M88 132c4 34 22 46 40 46s36-12 40-46c-8 12-22 16-40 16s-32-4-40-16z" fill="${hair}"/>` : "",
    // Eyes, smile, cheeks.
    `<circle cx="110" cy="120" r="5" fill="${line}"/><circle cx="146" cy="120" r="5" fill="${line}"/>`,
    `<path d="M112 146c8 9 24 9 32 0" fill="none" stroke="${line}" stroke-width="4" stroke-linecap="round"/>`,
    m ? "" : `<circle cx="98" cy="138" r="7" fill="${AVATAR_COLORS.amber}" opacity="0.35"/><circle cx="158" cy="138" r="7" fill="${AVATAR_COLORS.amber}" opacity="0.35"/>`,
    look.glasses ? `<g fill="none" stroke="${line}" stroke-width="3.5"><circle cx="110" cy="120" r="13"/><circle cx="146" cy="120" r="13"/><path d="M123 120h10"/></g>` : "",
    `</svg>`,
  ].join("");
}

/** An organisation's logo: open hands holding a heart, on a rounded square. */
export function logoSvg(bg: string = AVATAR_COLORS.okDeep, mark: string = AVATAR_COLORS.amber): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`,
    `<rect width="256" height="256" fill="${bg}"/>`,
    `<path d="M128 150c-30-20-46-36-46-56 0-14 10-24 23-24 10 0 18 6 23 15 5-9 13-15 23-15 13 0 23 10 23 24 0 20-16 36-46 56z" fill="${mark}"/>`,
    `<path d="M52 150c10 0 18 4 26 12l26 22c6 5 14 8 24 8s18-3 24-8l26-22c8-8 16-12 26-12" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join("");
}

/** As a data URL for <img> and SVG <image> (the app's CSP allows data: images). */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
