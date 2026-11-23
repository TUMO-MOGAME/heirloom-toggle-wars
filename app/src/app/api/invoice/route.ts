import { dailyCap, handler, HttpError, json, rateLimitShared } from "@/lib/api/http";
import { MAX_UPLOAD_BYTES, validateUpload } from "@/lib/storage";
import { sha256Hex } from "@/lib/agent/hash";
import { readInvoice } from "@/lib/agent/invoice";

// Room for one retry of a slow or malformed AI answer (two 25 s calls plus the upload); Vercel Pro allows it.
export const maxDuration = 120;

/**
 * POST /api/invoice (multipart: file). Pay a bill once (plan.md §13.2): the AI reads the invoice the owner is about to
 * pay (amount, payee, reference) so the app can compare it with what they typed. Unlike /api/review, the file is NOT
 * stored and nothing goes on-chain: it is read in memory and only its SHA-256 is returned.
 * Returns { reading, sha256, engine: "ai" | "none" }.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "invoice", 8);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64_000) throw new HttpError(413, "The file is larger than 4 MB.", "too_large");
  const form = await req.formData().catch(() => { throw new HttpError(400, "Expected a form upload with the invoice as `file`."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Attach the invoice as `file`.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = validateUpload(bytes, file.type);
  const sha256 = await sha256Hex(bytes);
  await dailyCap(req, "model");
  const { reading, engine } = await readInvoice({ bytes, mime, sha256 });
  return json({ reading, sha256, engine });
});
