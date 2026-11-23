import "server-only";
/**
 * Server-side WebP conversion for browsers that cannot encode WebP from a canvas (some Safari versions).
 * The upload is a JPEG/PNG/HEIC/HEIF (checked by magic bytes, ≤ 4 MB); sharp applies the EXIF orientation,
 * fits it inside 1600 x 1600 without enlarging and writes WebP at quality 82 (then 72, 60 if over 1.5 MB).
 * sharp writes no metadata unless asked (`withMetadata` is never called), so EXIF/GPS/ICC are dropped.
 * Note: the prebuilt sharp decodes AVIF-in-HEIF but not HEVC HEIC; the browser fallback sends JPEG first.
 */
import sharp, { type OutputInfo } from "sharp";
import { HttpError } from "@/lib/api/http";
import { MAX_EDGE, MAX_PHOTO_BYTES } from "../webp";

export async function convertOnServer(bytes: Uint8Array, label: string): Promise<{ webp: Uint8Array; width: number; height: number }> {
  for (const quality of [82, 72, 60]) {
    let out: { data: Buffer; info: OutputInfo };
    try {
      out = await sharp(bytes, { limitInputPixels: 60_000_000, failOn: "error" })
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new HttpError(400, `${label} could not be read. Please try a JPEG or PNG.`, "unreadable");
    }
    if (out.data.length <= MAX_PHOTO_BYTES) return { webp: new Uint8Array(out.data), width: out.info.width, height: out.info.height };
  }
  throw new HttpError(413, `${label} is still over 1.5 MB after converting. Please choose a simpler photo.`);
}
