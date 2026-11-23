/**
 * Asset photos as WebP. Two halves:
 *  - pure helpers used on the server and in the browser: the RIFF/WEBP magic-byte check, reading a WebP's
 *    real width and height from its header, and the photo-set root that goes on-chain;
 *  - the browser conversion: decode the picked image, draw it on a canvas with the long edge capped at 1600 px
 *    and re-encode it as WebP (quality 0.82). Re-encoding drops EXIF, so GPS and camera data never leave the
 *    phone. The canvas part sits behind a small `WebpEncoder` seam so tests can use a fake.
 *  - the fallback for browsers that cannot encode WebP (some Safari versions): `preparePhoto` re-encodes to JPEG
 *    on the canvas (also EXIF-free, ≤ 1600 px), or failing that keeps the original JPEG/PNG/HEIC, and marks it
 *    "raw"; the server then converts it to WebP with sharp (lib/media/server/convert.ts).
 */
import { sha256Hex } from "../agent/hash";
import { photosRootHex } from "../guardians/photos";

/** Photos per asset (the program's MAX_PHOTOS; raised from 8 on 15 Nov 2026). */
export const MAX_PHOTOS = 24;
export const MAX_EDGE = 1600;
export const WEBP_QUALITY = 0.82;
/** 1.5 MB per photo after conversion (checked again on the server). */
export const MAX_PHOTO_BYTES = 1_500_000;
/** Refuse absurd inputs before decoding (a 48 MP phone photo is ~15 MB). */
export const MAX_INPUT_BYTES = 40_000_000;
/** Originals sent for server-side conversion (JPEG/PNG/HEIC/HEIF), per photo. */
export const MAX_ORIGINAL_BYTES = 4_000_000; // under Vercel's ~4.5 MB request limit
/** Root stored on-chain when an asset has no photos (matches the program's default [0; 32]). */
export const EMPTY_ROOT = "0".repeat(64);

/* ---------- pure helpers ---------- */

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/** True when the bytes start with a RIFF container holding a WEBP image chunk (VP8, VP8L or VP8X). */
export function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return false;
  return ["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4));
}

/** Reads a WebP's pixel size from its first chunk header, or null if the header is not a valid WebP. */
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isWebp(bytes) || bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return { width: u24(bytes, 24) + 1, height: u24(bytes, 27) + 1 };
  if (chunk === "VP8 ") {
    // Lossy key frame: 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16(bytes, 26) & 0x3fff, height: u16(bytes, 28) & 0x3fff };
  }
  // VP8L (lossless): signature 0x2f, then (width-1) and (height-1) as 14-bit fields.
  if (bytes[20] !== 0x2f || bytes.length < 25) return null;
  const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

export type RawImageType = "jpeg" | "png" | "heif" | "avif";
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"];
const AVIF_BRANDS = ["avif", "avis"];

/** Identifies a JPEG, PNG, HEIC/HEIF or AVIF original by its magic bytes (never by the content type), or null. */
export function sniffImage(bytes: Uint8Array): RawImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v)) return "png";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && AVIF_BRANDS.includes(ascii(bytes, 8, 4))) return "avif";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && HEIF_BRANDS.includes(ascii(bytes, 8, 4))) return "heif";
  return null;
}

const HEX64 = /^[0-9a-f]{64}$/;
export const isSha256Hex = (s: string) => HEX64.test(s);

/**
 * The photo set's root: SHA-256 of the photos' raw 32-byte SHA-256 digests concatenated in display order
 * (no Merkle tree). Changing, adding, removing or reordering a photo changes the root. No photos = EMPTY_ROOT.
 * One implementation shared with the services: lib/guardians/photos.ts.
 */
export const photosRoot = (sha256s: readonly string[]): Promise<string> => photosRootHex([...sha256s]);

/** Scales (width, height) down so the long edge is at most `maxEdge`, keeping the aspect ratio. Never upscales. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new Error("The image has no size.");
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/* ---------- browser conversion ---------- */

export type WebpErrorCode = "not_image" | "too_large_input" | "decode" | "unsupported" | "too_large";

export class WebpError extends Error {
  constructor(public code: WebpErrorCode, message: string) { super(message); this.name = "WebpError"; }
}

/** A decoded image that can be drawn at a given size and exported. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Draws the image at width x height and exports it; resolves null if the browser could not export. */
  render(width: number, height: number, type: string, quality: number): Promise<Blob | null>;
  release(): void;
}

/** The seam: the real one uses createImageBitmap + canvas; tests pass a fake. */
export interface WebpEncoder { load(file: Blob): Promise<DecodedImage> }

export interface WebpPhoto { blob: Blob; width: number; height: number; bytes: number; sha256: string }

const looksLikeImage = (f: Blob) => {
  const name = "name" in f ? String((f as File).name).toLowerCase() : "";
  return f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif|gif)$/.test(name);
};

/**
 * Converts one picked image (JPEG, PNG, WebP, AVIF, HEIC where the browser can decode it) to WebP, long edge ≤ 1600 px.
 * If the result is over 1.5 MB it retries at lower quality, then at a smaller size.
 * Throws WebpError with a plain-language message the UI can show.
 */
export async function convertToWebp(file: Blob, encoder: WebpEncoder = browserEncoder): Promise<WebpPhoto> {
  if (!looksLikeImage(file)) throw new WebpError("not_image", "This file is not a photo.");
  if (file.size > MAX_INPUT_BYTES) throw new WebpError("too_large_input", "This photo is too large to open. Please choose a smaller one.");
  let img: DecodedImage;
  try { img = await encoder.load(file); } catch {
    throw new WebpError("decode", "This photo could not be opened on this device. Try a JPEG or PNG.");
  }
  try {
    const attempts: [number, number][] = [[MAX_EDGE, WEBP_QUALITY], [MAX_EDGE, 0.72], [MAX_EDGE, 0.6], [1200, 0.6]];
    for (const [edge, quality] of attempts) {
      const size = fitWithin(img.width, img.height, edge);
      const blob = await img.render(size.width, size.height, "image/webp", quality);
      if (!blob) throw new WebpError("unsupported", "This browser could not save the photo as WebP. Please use a current Chrome, Edge, Firefox or Safari.");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // Browsers that cannot encode WebP silently return PNG from toBlob: never trust the type, check the bytes.
      if (!isWebp(bytes)) throw new WebpError("unsupported", "This browser cannot make WebP photos. Please use a current Chrome, Edge or Firefox.");
      if (bytes.length <= MAX_PHOTO_BYTES) {
        const webp = blob.type === "image/webp" ? blob : new Blob([bytes], { type: "image/webp" });
        return { blob: webp, width: size.width, height: size.height, bytes: bytes.length, sha256: await sha256Hex(bytes) };
      }
    }
    throw new WebpError("too_large", "This photo is still over 1.5 MB after shrinking. Please choose a simpler photo.");
  } finally {
    img.release();
  }
}

/** A photo ready to upload: WebP made here ("new"), or an EXIF-free JPEG / original for the server to convert ("raw"). */
export type PreparedPhoto = { kind: "new"; photo: WebpPhoto } | { kind: "raw"; photo: WebpPhoto };

/**
 * convertToWebp, and when this browser cannot make WebP, the server-conversion fallback: a canvas JPEG at
 * ≤ 1600 px (drops EXIF; Safari can decode HEIC itself), else the original if it is a JPEG/PNG/HEIC/AVIF ≤ 4 MB
 * (the server's sharp reads AVIF).
 * For "raw" photos, width/height are what was sent and sha256 is of the bytes sent (the server re-hashes the WebP).
 */
export async function preparePhoto(file: Blob, encoder: WebpEncoder = browserEncoder): Promise<PreparedPhoto> {
  try {
    return { kind: "new", photo: await convertToWebp(file, encoder) };
  } catch (e) {
    if (!(e instanceof WebpError) || e.code !== "unsupported") throw e;
  }
  try {
    const img = await encoder.load(file);
    try {
      const size = fitWithin(img.width, img.height, MAX_EDGE);
      const blob = await img.render(size.width, size.height, "image/jpeg", 0.9);
      const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      if (blob && bytes && sniffImage(bytes) === "jpeg" && bytes.length <= MAX_ORIGINAL_BYTES) {
        return { kind: "raw", photo: { blob, width: size.width, height: size.height, bytes: bytes.length, sha256: await sha256Hex(bytes) } };
      }
    } finally { img.release(); }
  } catch { /* fall through to the original */ }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffImage(bytes)) throw new WebpError("unsupported", "This photo type cannot be converted. Please use a JPEG, PNG or AVIF.");
  if (bytes.length > MAX_ORIGINAL_BYTES) throw new WebpError("too_large", "This photo is over 4 MB. Please choose a smaller one.");
  return { kind: "raw", photo: { blob: file, width: 0, height: 0, bytes: bytes.length, sha256: await sha256Hex(bytes) } };
}

/** Real browser encoder: createImageBitmap (honours EXIF rotation) with an <img> fallback, drawn on a canvas. */
export const browserEncoder: WebpEncoder = {
  async load(file) {
    let source: ImageBitmap | HTMLImageElement;
    let url: string | null = null;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      url = URL.createObjectURL(file);
      const el = new Image();
      el.decoding = "async";
      el.src = url;
      await el.decode();
      source = el;
    }
    const width = "naturalWidth" in source ? source.naturalWidth : source.width;
    const height = "naturalHeight" in source ? source.naturalHeight : source.height;
    return {
      width, height,
      render(w, h, type, quality) {
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return Promise.resolve(null);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, w, h);
        return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      },
      release() {
        if ("close" in source) source.close();
        if (url) URL.revokeObjectURL(url);
      },
    };
  },
};
