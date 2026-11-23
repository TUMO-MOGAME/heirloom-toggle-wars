/**
 * Prepares a photo for the Trust Tree in the browser (plan.md §15.11): centre-crops it to a square, draws it at
 * 256×256 on a canvas and encodes it as WebP. Drawing on a canvas keeps only pixels, so EXIF data (camera, time,
 * location) never leaves the device. Quality steps down until the image fits in 60 KB; if it never does, or the
 * browser cannot encode WebP, the photo is refused with a reason the card can word.
 */
import { checkPhoto, PHOTO_SIZE } from "./photos";

export type PhotoPrepError = "notImage" | "unreadable" | "tooLarge" | "noWebp";

export class PhotoPrepFailure extends Error {
  constructor(public reason: PhotoPrepError) { super(`photo:${reason}`); }
}

/** Files larger than this are not even opened (a phone photo is a few MB). */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const QUALITIES = [0.86, 0.78, 0.7, 0.6, 0.5, 0.4];

/** The centre square of a w×h image: source x, y and side. */
export function centreSquare(w: number, h: number): { sx: number; sy: number; side: number } {
  const side = Math.min(w, h);
  return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 2), side };
}

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; close(): void }> {
  if (typeof createImageBitmap === "function") {
    // imageOrientation "from-image" turns a phone photo upright before the EXIF data is dropped.
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** A 256×256 WebP data URL of at most 60 KB, or a PhotoPrepFailure. */
export async function prepareTreePhoto(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new PhotoPrepFailure("notImage");
  if (file.size > MAX_INPUT_BYTES) throw new PhotoPrepFailure("tooLarge");
  let src: Awaited<ReturnType<typeof decode>>;
  try { src = await decode(file); } catch { throw new PhotoPrepFailure("unreadable"); }
  try {
    if (!src.w || !src.h) throw new PhotoPrepFailure("unreadable");
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_SIZE;
    canvas.height = PHOTO_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoPrepFailure("unreadable");
    const { sx, sy, side } = centreSquare(src.w, src.h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src.img, sx, sy, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    for (const q of QUALITIES) {
      const url = canvas.toDataURL("image/webp", q);
      // A browser without a WebP encoder hands back PNG instead.
      if (!url.startsWith("data:image/webp")) throw new PhotoPrepFailure("noWebp");
      const why = checkPhoto(url);
      if (why === null) return url;
      if (why === "type") throw new PhotoPrepFailure("noWebp");
    }
    throw new PhotoPrepFailure("tooLarge");
  } finally {
    src.close();
  }
}

