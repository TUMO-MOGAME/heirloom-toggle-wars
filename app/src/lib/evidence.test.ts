/** C2: a document the review would refuse is refused on the device, before anything is signed. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEvidence, demoSample, EVIDENCE_ACCEPT, EVIDENCE_MAX_BYTES, requireEvidence, sampleFile } from "./evidence";
import { SPECIMEN_SHA256 } from "./agent/specimens";

const PDF = "%PDF-1.4 demo";

describe("checkEvidence", () => {
  it("takes a PDF, JPG or PNG whose bytes match its type", async () => {
    expect("file" in await checkEvidence(new File([PDF], "a.pdf", { type: "application/pdf" }))).toBe(true);
    expect("file" in await checkEvidence(new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], "a.jpg", { type: "image/jpeg" }))).toBe(true);
  });
  it("refuses the old demo stand-in: text called application/pdf", async () => {
    expect(await checkEvidence(new File(["Heirloom demo document: x.pdf"], "x.pdf", { type: "application/pdf" }))).toEqual({ problem: "FileType" });
  });
  it.each([
    ["empty", new File([], "a.pdf", { type: "application/pdf" }), "FileEmpty"],
    ["too big", new File([PDF, new Uint8Array(EVIDENCE_MAX_BYTES)], "a.pdf", { type: "application/pdf" }), "FileSize"],
    ["WebP", new File(["RIFF....WEBP"], "a.webp", { type: "image/webp" }), "FileType"],
    ["a PDF named as a PNG", new File([PDF], "a.png", { type: "image/png" }), "FileType"],
  ])("refuses %s", async (_n, file, problem) => expect(await checkEvidence(file)).toEqual({ problem }));
  it("gives a file without a type the type its bytes show", async () => {
    const r = await checkEvidence(new File([PDF], "a.pdf"));
    expect("file" in r && r.file.type).toBe("application/pdf");
  });
  it("services refuse with a code", async () => {
    await expect(requireEvidence(new File(["x"], "x.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "FileType" });
  });
  it("the picker offers no WebP or HEIC", () => expect(EVIDENCE_ACCEPT).toBe("application/pdf,image/jpeg,image/png"));
});

describe("samples", () => {
  const dir = join(__dirname, "../../public/demo/documents");
  it("are Heirloom's own demo documents, byte for byte", () => {
    const files = readdirSync(dir);
    expect(files.length).toBe(7);
    for (const f of files) expect(SPECIMEN_SHA256.has(createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")), f).toBe(true);
  });
  it("are offered only where they fit the family", () => {
    expect(sampleFile("death-certificate-t-mokoena.pdf", { owner: "Thabo Mokoena" })).toMatch(/thabo-mokoena\.pdf$/);
    expect(sampleFile("death-certificate-t-mokoena.pdf", { owner: "Grace Dube" })).toBeNull();
    expect(sampleFile("fee-statement-2027.pdf", { me: "Sipho Mokoena (son)" })).toMatch(/sipho\.pdf$/);
    expect(sampleFile("affidavit-edited.pdf", { me: "Lerato Mokoena" })).toBeNull();
    expect(sampleFile("death-certificate-trusted-person.pdf", { owner: "Thabo Mokoena" })).toBeNull();
    for (const f of ["1-death-certificate-thabo-mokoena.pdf", "2-uct-fee-statement-lerato.pdf"]) expect(readdirSync(dir)).toContain(f);
  });
  it("the demo's stand-ins pass the same check", async () => {
    expect("file" in await checkEvidence(demoSample("school-trip-letter.pdf", "School trip letter"))).toBe(true);
  });
});
