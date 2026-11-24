import { describe, expect, it } from "vitest";
import { legacy, legacyEntry, legacySafety, type LegacyBundleCopy } from "../legacy";
import { af } from "./af";
import { st } from "./st";
import { zu } from "./zu";

const english: LegacyBundleCopy = { page: legacy, entry: legacyEntry, safety: legacySafety };

/** Every string slot with its path, English and translation side by side. */
function* slots(en: unknown, tr: unknown, path = ""): Generator<[string, unknown, unknown]> {
  if (typeof en === "string") { yield [path, en, tr]; return; }
  if (Array.isArray(en)) {
    if (!Array.isArray(tr) || tr.length !== en.length) { yield [path, en, tr]; return; }
    for (let i = 0; i < en.length; i++) yield* slots(en[i], tr[i], `${path}[${i}]`);
    return;
  }
  if (en && typeof en === "object") for (const k of Object.keys(en)) yield* slots((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
}
const holes = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);
// English pronouns ("he", "his") fill these, so the translations name the parent with {called} instead.
const ENGLISH_ONLY = new Set(["{pronoun}", "{possessive}", "{calledLower}"]);

describe.each([["af", af], ["st", st], ["zu", zu]] as const)("Legacy Voice in %s", (_name, t) => {
  it("translates every line (the bundle is complete)", () => {
    const missing = [...slots(english, t.legacy)].filter(([, , tr]) => typeof tr !== "string" || !tr.trim()).map(([p]) => p);
    expect(missing).toEqual([]);
  });

  it("keeps every placeholder except the English pronouns, and invents none", () => {
    const wrong: string[] = [];
    for (const [path, en, tr] of slots(english, t.legacy)) {
      const want = [...holes(en as string)].filter((x) => !ENGLISH_ONLY.has(x));
      const got = holes(tr as string);
      // {called} may stand in for a pronoun (it is filled wherever the pronouns are).
      const allowed = new Set([...holes(en as string), ...([...holes(en as string)].some((x) => ENGLISH_ONLY.has(x)) ? ["{called}"] : [])]);
      if (want.some((x) => !got.has(x)) || [...got].some((x) => !allowed.has(x) || ENGLISH_ONLY.has(x))) wrong.push(`${path}: ${String(tr)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("keeps help-line numbers, brand names and the product name as they are", () => {
    expect(t.legacy.safety.lines.map((l) => [l.number, l.tel])).toEqual(legacySafety.lines.map((l) => [l.number, l.tel]));
    for (const [path, en, tr] of slots(english, t.legacy)) {
      for (const keep of ["Heirloom", "ElevenLabs", "SADAG", "sadag.org"]) if ((en as string).includes(keep)) expect(tr, `${path} keeps ${keep}`).toContain(keep);
    }
  });
});
