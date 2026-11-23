/**
 * A one-page PDF "request note" for a request with no letter or quote attached. On-chain every claim carries the
 * SHA-256 of a document and the agent must check it before anyone can approve, so the app writes the request down
 * (who, what for, how much, to whom, when) and that note is what gets hashed and checked. Plain text in Helvetica;
 * characters outside Latin-1 are replaced (USD₮ is written "USDT").
 */

/** PDF string literal: Latin-1 only, with ( ) \ escaped. */
function pdfText(s: string): string {
  const latin = s.replace(/₮/g, "T").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  return `(${latin.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** Splits a long line into lines of at most `width` characters, at spaces where possible. */
export function wrap(text: string, width = 80): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
    while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
  }
  if (line) out.push(line);
  return out;
}

export function requestNotePdf(title: string, lines: string[]): Uint8Array {
  const body = [title, "", ...lines.flatMap((l) => (l ? wrap(l) : [""]))];
  const ops = ["BT", "/F1 16 Tf", "72 760 Td", `${pdfText(body[0])} Tj`, "/F1 11 Tf", "0 -10 Td"];
  for (const l of body.slice(1)) ops.push("0 -16 Td", `${pdfText(l)} Tj`);
  ops.push("ET");
  const stream = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${latin1(stream).length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(latin1(pdf).length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = latin1(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(pdf);
}

/** Every character here is already Latin-1 (pdfText made sure), one byte each. */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
