import { handler, HttpError, rateLimit } from "@/lib/api/http";
import { getPhoto, verifyPhotoUrl } from "@/lib/media/server/store";

const PATH = /^[0-9a-f]{24}\/[0-9a-f]{24}\/[0-9a-f]{64}\.webp$/;

/**
 * GET /api/assets/photos/file?p=<path>&e=<expiry>&s=<hmac> → the WebP bytes. The URL is signed by the server
 * (see signedPhotoUrl) and expires after an hour, so the private bucket is never exposed. The bytes were checked
 * as WebP on upload; nosniff and a locked-down CSP keep browsers from treating them as anything else.
 */
export const GET = handler(async (req) => {
  rateLimit(req, "asset-photos-file", 240);
  const q = new URL(req.url).searchParams;
  const p = q.get("p") ?? "";
  if (!PATH.test(p) || !verifyPhotoUrl(p, Number(q.get("e")), q.get("s") ?? "")) throw new HttpError(404, "Not found", "not_found");
  const bytes = await getPhoto(p);
  if (!bytes) throw new HttpError(404, "Not found", "not_found");
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": "image/webp", "cache-control": "private, max-age=3600, immutable",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
    },
  });
});
