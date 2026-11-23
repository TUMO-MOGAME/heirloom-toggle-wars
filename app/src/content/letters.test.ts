/** Letters for later copy: every key translated in af/st/zu with the same {placeholders} and marks; no AI-voice words. */
import { describe, expect, it } from "vitest";
import { letters } from "./letters";
import { lettersAf, lettersSt, lettersZu } from "./i18n/letters";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";
import { assistant } from "./assistant";
import { LETTER_WARNING_CODES } from "@/lib/letters/types";

function* strings(en: unknown, tr: unknown, path = ""): Generator<[string, string, unknown]> {
  if (typeof en === "string") { yield [path, en, tr]; return; }
  if (en && typeof en === "object") for (const k of Object.keys(en)) yield* strings((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
}
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
const marks = (s: string) => (s.match(/\*/g) ?? []).length;

describe("English letters copy", () => {
  it("has a line for every warning code and every opening kind", () => {
    for (const c of LETTER_WARNING_CODES) expect(letters.review.codes[c], c).toBeTruthy();
    for (const k of ["unlock", "date", "payment", "send"] as const) expect(letters.help.templates[k], k).toContain("{name}");
  });

  it("says nothing about copied or recorded voices (text only in this build)", () => {
    for (const [path, en] of strings(letters, letters)) expect(en, path).not.toMatch(/\bvoice|\bclone|\brecord(ed|ing)?\b|\baudio/i);
  });

  it("keeps the not-part-of-the-will line", () => {
    expect(letters.notWill).toMatch(/not part of your will/);
  });
});

describe.each([["af", lettersAf, af], ["st", lettersSt, st], ["zu", lettersZu, zu]] as const)("%s letters copy", (_n, t, bundle) => {
  it("is the bundle's letters slice", () => expect(bundle.letters).toBe(t));

  it("translates every key, keeping placeholders, marks, USD₮, Heirloom and people's names", () => {
    const wrong: string[] = [];
    for (const [path, en, tr] of strings(letters, t)) {
      if (typeof tr !== "string" || !tr.trim()) { wrong.push(`${path}: missing`); continue; }
      if (placeholders(tr) !== placeholders(en)) wrong.push(`${path}: placeholders`);
      if (marks(tr) !== marks(en)) wrong.push(`${path}: marks`);
      for (const keep of ["Heirloom", "USD₮", "Lerato", "Sipho", "Naledi", "Bongani", "Corolla", "Soweto", "Thabo"]) if (en.includes(keep) && !tr.includes(keep)) wrong.push(`${path}: ${keep}`);
      if (tr === en && en.length > 12 && !/^\{\w+\}$/.test(en)) wrong.push(`${path}: still English`);
    }
    expect(wrong).toEqual([]);
  });

  it("translates the menu item and the agent's page name", () => {
    expect(bundle.assistant.shell?.nav?.letters).toBeTruthy();
    expect(bundle.assistant.shell?.nav?.letters).not.toBe(assistant.shell.nav.letters);
    expect(bundle.assistant.actions?.pages?.["/letters"]).toBeTruthy();
  });
});
