/** "Ask for money" copy: every key translated in af/st/zu, with the same {placeholders}, marks, brand words and sample files. */
import { describe, expect, it } from "vitest";
import { ask } from "./ask";
import { askAf, askSt, askZu } from "./i18n/ask";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";

function* strings(en: unknown, tr: unknown, path = ""): Generator<[string, string, unknown]> {
  if (typeof en === "string") { yield [path, en, tr]; return; }
  if (Array.isArray(en)) { for (let i = 0; i < en.length; i++) yield* strings(en[i], Array.isArray(tr) ? tr[i] : undefined, `${path}[${i}]`); return; }
  if (en && typeof en === "object") for (const k of Object.keys(en)) yield* strings((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
}
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
const marks = (s: string) => (s.match(/\*/g) ?? []).length;

describe.each([["af", askAf, af], ["st", askSt, st], ["zu", askZu, zu]] as const)("%s ask copy", (_n, t, bundle) => {
  it("is the bundle's ask slice", () => expect(bundle.ask).toBe(t));

  it("translates every key, keeping placeholders, marks, USD₮ and the sample file names", () => {
    const wrong: string[] = [];
    for (const [path, en, tr] of strings(ask, t)) {
      if (typeof tr !== "string" || !tr.trim()) { wrong.push(`${path}: missing`); continue; }
      if (placeholders(tr) !== placeholders(en)) wrong.push(`${path}: placeholders`);
      if (marks(tr) !== marks(en)) wrong.push(`${path}: marks`);
      if (en.includes("USD₮") && !tr.includes("USD₮")) wrong.push(`${path}: USD₮`);
      if (path.endsWith(".fileName") && tr !== en) wrong.push(`${path}: file name`);
    }
    expect(wrong).toEqual([]);
    expect(t.sheet.ideas).toHaveLength(ask.sheet.ideas.length);
    expect(t.sheet.samples).toHaveLength(ask.sheet.samples.length);
  });
});
