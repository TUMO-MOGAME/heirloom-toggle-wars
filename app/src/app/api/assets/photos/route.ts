import { z } from "zod";
import { handler, HttpError, json, rateLimit } from "@/lib/api/http";
import { sha256Hex } from "@/lib/agent/hash";
import { isAssetKind, MAX_DESCRIPTION, MAX_MANIFEST_CHARS, MAX_REQUEST_BYTES, type PhotosListResponse } from "@/lib/media/api";
import { cleanSpec, foreignSpecKeys, PHOTO_LABELS, withLabel } from "@/lib/assets/spec";
import { specInputSchema } from "@/lib/assets/spec-schema";
import { isWebp, MAX_EDGE, MAX_ORIGINAL_BYTES, MAX_PHOTO_BYTES, MAX_PHOTOS, sniffImage, webpSize } from "@/lib/media/webp";
import { convertOnServer } from "@/lib/media/server/convert";
import { authorizeOwner, photosAvailable } from "@/lib/media/server/auth";
import { getMedia, listMedia, photoPath, putPhoto, saveMedia, toInfo, type MediaRow, type PhotoRow } from "@/lib/media/server/store";

export const maxDuration = 30;

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,48}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.object({
  asset: addr,
  kind: z.string().refine(isAssetKind, "Unknown asset kind"),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(MAX_DESCRIPTION).default(""),
  order: z.array(sha).max(MAX_PHOTOS),
  files: z.array(sha).max(MAX_PHOTOS),
  labels: z.array(z.union([z.enum(PHOTO_LABELS), z.literal("")])).max(MAX_PHOTOS).optional(),
  spec: specInputSchema.nullable().optional(),
});
const deleteSchema = z.object({ asset: addr, sha256: sha });

/**
 * GET /api/assets/photos → { available } (is there a photo server here?).
 * GET /api/assets/photos?estate=<address> → { assets: AssetMediaInfo[] } with short-lived signed URLs. Anyone who
 * can see the estate (family, trusted people, buyers) may read: these are photos of things for sale.
 */
export const GET = handler(async (req) => {
  const estate = new URL(req.url).searchParams.get("estate");
  if (!estate) { rateLimit(req, "asset-photos-probe", 60); return json({ available: photosAvailable() }); }
  rateLimit(req, "asset-photos-read", 60);
  const e = addr.safeParse(estate);
  if (!e.success) throw new HttpError(400, "Unknown estate address.");
  const rows = await listMedia(e.data);
  const out: PhotosListResponse = { assets: await Promise.all(rows.map(toInfo)) };
  return json(out);
});

/**
 * POST /api/assets/photos (multipart, owner only, estate Active):
 *   manifest = JSON { asset, kind, title, description, order: sha256[] (the full ordered set, ≤ 24), files: sha256[] of the
 *              photos sent, labels: label per `order` entry ("" = none), spec: spec sheet or null }
 *   photos   = WebP files ≤ 1.5 MB, or (browsers that cannot encode WebP) JPEG/PNG/HEIC/HEIF/AVIF originals ≤ 4 MB that
 *              are converted here with sharp; both checked by magic bytes (the content type is never trusted).
 *              Only the WebP is stored and hashed; `files` / `order` name a converted photo by its original's hash.
 * The signature covers the manifest text, and the server recomputes every file's SHA-256, so the signed set is
 * exactly what is stored. Photos left out of `order` are deleted. → AssetMediaInfo (signed URLs, photosRoot).
 */
export const POST = handler(async (req) => {
  rateLimit(req, "asset-photos-upload", 12);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > Math.max(MAX_REQUEST_BYTES, MAX_ORIGINAL_BYTES) + 512 * 1024) throw new HttpError(413, "Too many photos in one go. Please try again.");
  const form = await req.formData().catch(() => { throw new HttpError(400, "Expected a form upload."); });
  const text = form.get("manifest");
  if (typeof text !== "string" || text.length > MAX_MANIFEST_CHARS) throw new HttpError(400, "The upload is missing its list of photos.");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HttpError(400, "The upload's list of photos is not valid."); }
  const m = manifestSchema.parse(raw);
  if (new Set(m.order).size !== m.order.length) throw new HttpError(400, "The same photo is in the list twice.");
  if (m.labels && m.labels.length !== m.order.length) throw new HttpError(400, "Each photo needs one label entry.");
  const foreign = foreignSpecKeys(m.kind as MediaRow["kind"], m.spec);
  if (foreign.length) throw new HttpError(400, `These details do not belong on this kind of asset: ${foreign.join(", ")}.`, "spec_kind");

  const files = form.getAll("photos").filter((f): f is File => f instanceof File);
  if (files.length > MAX_PHOTOS) throw new HttpError(400, `At most ${MAX_PHOTOS} photos per asset.`);
  if (files.length !== m.files.length) throw new HttpError(400, "The photos sent do not match the list.");
  // Check every file (sizes, magic bytes, signed hashes) before converting anything.
  const sent: { bytes: Uint8Array; raw: boolean }[] = [];
  for (const [i, f] of files.entries()) {
    if (f.size > MAX_ORIGINAL_BYTES) throw new HttpError(413, `Photo ${i + 1} is larger than 4 MB.`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const webp = isWebp(bytes);
    if (!webp && !sniffImage(bytes)) throw new HttpError(400, `Photo ${i + 1} is not a WebP, JPEG, PNG, HEIC or AVIF image.`, "not_webp");
    if (bytes.length > (webp ? MAX_PHOTO_BYTES : MAX_ORIGINAL_BYTES)) throw new HttpError(413, `Photo ${i + 1} is larger than ${webp ? "1.5" : "4"} MB.`);
    if (await sha256Hex(bytes) !== m.files[i]) throw new HttpError(400, `Photo ${i + 1} does not match the signed list.`);
    sent.push({ bytes, raw: !webp });
  }
  // Signature, owner and Active estate are checked before any (CPU-heavy) conversion.
  const owner = await authorizeOwner(req, "photos.upload", await sha256Hex(text), m.asset);
  // `sentSha` = hash in the signed manifest; row.sha256 = hash of the WebP that is stored (equal for WebP uploads).
  const fresh: { sentSha: string; row: PhotoRow; bytes: Uint8Array }[] = [];
  for (const [i, s] of sent.entries()) {
    let bytes = s.bytes;
    let size = webpSize(bytes);
    if (s.raw) {
      const c = await convertOnServer(bytes, `Photo ${i + 1}`);
      bytes = c.webp; size = { width: c.width, height: c.height };
    }
    if (!size || !isWebp(bytes)) throw new HttpError(400, `Photo ${i + 1} is not a valid WebP image.`, "not_webp");
    if (Math.max(size.width, size.height) > MAX_EDGE) throw new HttpError(400, `Photo ${i + 1} is larger than ${MAX_EDGE} pixels.`);
    fresh.push({ sentSha: m.files[i], row: { sha256: await sha256Hex(bytes), path: "", width: size.width, height: size.height, bytes: bytes.length }, bytes });
  }

  const prev = await getMedia(owner.estate, m.asset);
  const known = new Map<string, PhotoRow>((prev?.photos ?? []).map((p) => [p.sha256, p]));
  const bySent = new Map<string, PhotoRow>();
  for (const f of fresh) {
    if (!m.order.includes(f.sentSha)) continue;
    const have = known.get(f.row.sha256);
    if (have) { bySent.set(f.sentSha, have); continue; }
    f.row.path = await photoPath(owner.estate, m.asset, f.row.sha256);
    await putPhoto(f.row.path, f.bytes);
    known.set(f.row.sha256, f.row);
    bySent.set(f.sentSha, f.row);
  }
  const photos = m.order.map((h, k): PhotoRow => {
    const p = bySent.get(h) ?? known.get(h);
    if (!p) throw new HttpError(400, "A photo in the list was never uploaded.");
    return withLabel(p, m.labels?.[k]);
  });
  if (new Set(photos.map((p) => p.sha256)).size !== photos.length) throw new HttpError(400, "The same photo is in the list twice.");
  const row: MediaRow = { estate: owner.estate, asset: m.asset, kind: m.kind as MediaRow["kind"], title: m.title, description: m.description, photos, spec: cleanSpec(m.spec), updatedAt: Math.floor(Date.now() / 1000) };
  await saveMedia(row, prev);
  return json(await toInfo(row));
});

/** DELETE /api/assets/photos { asset, sha256 } (owner only, estate Active) → the remaining AssetMediaInfo. */
export const DELETE = handler(async (req) => {
  rateLimit(req, "asset-photos-delete", 20);
  const text = await req.text();
  if (text.length > 2_000) throw new HttpError(413, "Request too large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON"); }
  const body = deleteSchema.parse(raw);
  const owner = await authorizeOwner(req, "photos.delete", await sha256Hex(text), body.asset);
  const prev = await getMedia(owner.estate, body.asset);
  if (!prev?.photos.some((p) => p.sha256 === body.sha256)) throw new HttpError(404, "That photo is not on this asset.", "not_found");
  const row: MediaRow = { ...prev, photos: prev.photos.filter((p) => p.sha256 !== body.sha256), updatedAt: Math.floor(Date.now() / 1000) };
  await saveMedia(row, prev);
  return json(await toInfo(row));
});
