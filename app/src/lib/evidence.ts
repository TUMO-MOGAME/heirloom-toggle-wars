/**
 * The documents the agent reviews (death certificates, fee statements, affidavits, letters, registration papers):
 * checked on the device before anything is signed (plan §18.9 C2). The server takes only what /api/review takes
 * (lib/storage.ts validateUpload: a PDF, JPG or PNG whose bytes match its type), and the hosting platform takes at
 * most 4.5 MB in a request, so a file that would be refused after its transaction must never get that far.
 * Client-safe and pure apart from reading the file.
 */
import { requestNotePdf } from "./ask/note-pdf";

import { ALLOWED_MIME, MAX_UPLOAD_BYTES, sniff } from "./evidence-file";

/** The server's own rule (evidence-file.ts), so the two can't drift. */
export const EVIDENCE_TYPES = ALLOWED_MIME;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export const EVIDENCE_MAX_BYTES = MAX_UPLOAD_BYTES;
/** What the file pickers offer: no WebP or HEIC (iPhones convert HEIC photos to JPEG when only JPEG is accepted). */
export const EVIDENCE_ACCEPT = EVIDENCE_TYPES.join(",");

export type EvidenceProblem = "FileEmpty" | "FileSize" | "FileType";

export const sniffEvidence = (b: Uint8Array): EvidenceType | null => sniff(b);

/**
 * The file as the server will see it, or why it would be refused. A file whose browser gave it no type (some phones
 * and file managers do) gets the type its bytes show; a declared type must match the bytes.
 */
export async function checkEvidence(file: File): Promise<{ file: File } | { problem: EvidenceProblem }> {
  if (file.size === 0) return { problem: "FileEmpty" };
  if (file.size > EVIDENCE_MAX_BYTES) return { problem: "FileSize" };
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const sniffed = sniffEvidence(head);
  if (!sniffed) return { problem: "FileType" };
  if (!file.type) return { file: new File([file], file.name, { type: sniffed, lastModified: file.lastModified }) };
  return file.type === sniffed ? { file } : { problem: "FileType" };
}

const WORDS: Record<EvidenceProblem, string> = {
  FileEmpty: "The file is empty.",
  FileSize: "The file is larger than 4 MB.",
  FileType: "Only a PDF, JPG or PNG whose contents match its type is accepted.",
};

/** For the services: the checked file, or a refusal shaped like the program's (code, then words). Nothing is signed. */
export async function requireEvidence(file: File): Promise<File> {
  const r = await checkEvidence(file);
  if ("problem" in r) throw Object.assign(new Error(`${r.problem}: ${WORDS[r.problem]}`), { code: r.problem });
  return r.file;
}

/* ---------- sample documents ---------- */

/**
 * Heirloom's own demo documents (docs/demo-documents, served from public/demo/documents), by the sample names the
 * screens use. Each is about one person of the demo family, so it is offered only where it fits: a certificate for
 * someone else, or a fee statement in another child's name, would only be refused, and a hardship request can be
 * made once per person. `null`: no real file, so only the demo (which reads samples by name) offers it.
 */
export function sampleFile(fileName: string, who: { owner?: string; me?: string }): string | null {
  const has = (name: string | undefined, part: string) => !!name && new RegExp(`\\b${part}\\b`, "i").test(name);
  const dir = "/demo/documents/";
  switch (fileName) {
    case "death-certificate-t-mokoena.pdf": return has(who.owner, "Thabo") ? `${dir}1-death-certificate-thabo-mokoena.pdf` : null;
    case "death-certificate-edited.pdf": return has(who.owner, "Thabo") ? `${dir}1-death-certificate-wrong-person-edited.pdf` : null;
    case "fee-statement-2027.pdf":
      return has(who.me, "Lerato") ? `${dir}2-uct-fee-statement-lerato.pdf` : has(who.me, "Sipho") ? `${dir}3-uct-fee-statement-sipho.pdf`
        : has(who.me, "Naledi") ? `${dir}4-westerford-fee-statement-naledi.pdf` : null;
    case "fee-statement-edited.pdf": return has(who.me, "Lerato") ? `${dir}2-fee-statement-altered-amount.pdf` : null;
    case "affidavit-saps-orlando.pdf": return has(who.me, "Lerato") ? `${dir}5-hardship-affidavit-lerato.pdf` : null;
    default: return null;
  }
}

/** The demo's stand-in for a sample with no real file: a small, valid PDF that says what it is. */
export function demoSample(fileName: string, label: string): File {
  const bytes = requestNotePdf(label, ["Heirloom demo specimen. A stand-in document for the simulated demo only.", "", fileName]);
  return new File([bytes as BlobPart], fileName, { type: "application/pdf" });
}
