/** The request note is a valid one-page PDF the upload check accepts (it is what gets hashed on-chain and reviewed). */
import { describe, expect, it } from "vitest";
import { requestNotePdf, wrap } from "./note-pdf";
import { validateUpload } from "../storage";

const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

describe("requestNotePdf", () => {
  const pdf = requestNotePdf("Heirloom request note", ["For: School trip (Grade 11)", "Amount: 19,44 USD₮", "Paid to: Lerato's own wallet", "", "Ŝtrange ☃ text"]);
  const s = text(pdf);

  it("is a PDF with a correct cross-reference table", () => {
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(s.match(/startxref\n(\d+)/)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    const len = Number(s.match(/\/Length (\d+)/)![1]);
    const start = s.indexOf("stream\n") + "stream\n".length;
    expect(s.slice(start + len, start + len + "\nendstream".length)).toBe("\nendstream");
  });

  it("escapes brackets and writes only Latin-1 (USD₮ as USDT)", () => {
    expect(s).toContain("(For: School trip \\(Grade 11\\)) Tj");
    expect(s).toContain("(Amount: 19,44 USDT) Tj");
    expect(s).toContain("(Strange ? text) Tj");
    expect(pdf.every((b) => b < 256)).toBe(true);
  });

  it("passes the server's upload check (type and magic bytes)", () => {
    expect(validateUpload(pdf, "application/pdf")).toBe("application/pdf");
  });

  it("wraps long lines at spaces", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrap("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});
