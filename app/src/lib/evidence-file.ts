/**
 * What an evidence upload (/api/review, /api/invoice) may be, checked the same way in the browser before anything is
 * signed and on the server. Browser-safe: no Node, no Supabase.
 *
 * 4 MB: Vercel refuses a function request body over 4.5 MB, and the form's other fields and boundaries need room, so a
 * larger file never reached the server's own check.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png"] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export class UploadError extends Error {
  constructor(message: string, public problem: UploadProblem = "content") { super(message); this.name = "UploadError"; }
}

/** Why a file can't be uploaded: for the screens' own words. */
export type UploadProblem = "empty" | "size" | "type" | "content";

export function sniff(b: Uint8Array): AllowedMime | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf"; // %PDF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

/** Null when the bytes may be uploaded as `mime`: not empty, at most 4 MB, PDF, JPG or PNG, and its contents match. */
export function uploadProblem(bytes: Uint8Array, mime: string): UploadProblem | null {
  if (bytes.byteLength === 0) return "empty";
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return "size";
  if (!(ALLOWED_MIME as readonly string[]).includes(mime)) return "type";
  return sniff(bytes) === mime ? null : "content";
}

/** The browser's check of a picked file, before any signature. Reads only its first bytes when the size is fine. */
export async function checkUploadFile(file: Blob & { type: string }): Promise<UploadProblem | null> {
  if (file.size === 0) return "empty";
  if (file.size > MAX_UPLOAD_BYTES) return "size";
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const problem = uploadProblem(head, file.type);
  return problem === "size" || problem === "empty" ? null : problem;
}

const WORDS: Record<UploadProblem, string> = {
  empty: "The file is empty.",
  size: "The file is larger than 4 MB.",
  type: "Only PDF, JPG or PNG files are accepted.",
  content: "The file's contents do not match its type.",
};

/** Checks size, declared type and magic bytes (so a renamed .exe is rejected). Throws UploadError. */
export function validateUpload(bytes: Uint8Array, mime: string): AllowedMime {
  const problem = uploadProblem(bytes, mime);
  if (problem) throw new UploadError(WORDS[problem], problem);
  return mime as AllowedMime;
}
