import "server-only";
/**
 * Evidence files (death certificates, fee statements, affidavits, registration papers).
 * Stored in the private Supabase Storage bucket `evidence` via the service-role key; only the
 * SHA-256 goes on-chain (POPIA). Without Supabase the file is checked, hashed and reviewed, then not kept.
 */
import { getSupabase } from "./supabase";
import { sha256Hex } from "./agent/hash";

export const BUCKET = "evidence";
export { ALLOWED_MIME, MAX_UPLOAD_BYTES, UploadError, sniff, validateUpload, type AllowedMime } from "./evidence-file";
import { validateUpload, type AllowedMime } from "./evidence-file";

/** "none": no Supabase here, so the file is not kept at all (only its hash is, on-chain). */
export interface StoredEvidence { path: string; sha256: string; mime: AllowedMime; size: number; backend: "supabase" | "none" }

const EXT: Record<AllowedMime, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

export async function storeEvidence(bytes: Uint8Array, mime: string, purpose: string): Promise<StoredEvidence> {
  const m = validateUpload(bytes, mime);
  const sha256 = await sha256Hex(bytes);
  const path = `${purpose}/${sha256}.${EXT[m]}`; // content-addressed: no names or personal data in the path
  const sb = getSupabase();
  if (sb) {
    const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: m, upsert: true });
    if (error) throw new Error(`Could not store the file: ${error.message}`);
    return { path, sha256, mime: m, size: bytes.byteLength, backend: "supabase" };
  }
  // Nothing ever read the in-memory copy (verifiers get links only from Supabase), so none is kept.
  return { path, sha256, mime: m, size: bytes.byteLength, backend: "none" };
}

/** Short-lived signed URL for verifiers to view a file (Supabase only). */
export async function signedEvidenceUrl(path: string, expiresInSecs = 300): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, expiresInSecs);
  return error ? null : data.signedUrl;
}
