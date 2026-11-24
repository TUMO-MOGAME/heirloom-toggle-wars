/** Spoken-language copy: every key translated in af/st/zu, with the same {placeholders}. */
import { describe, expect, it } from "vitest";
import { voice } from "./voice";
import { voiceAf, voiceSt, voiceZu } from "./i18n/voice";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";

function* strings(en: unknown, tr: unknown, path = ""): Generator<[string, string, unknown]> {
  if (typeof en === "string") { yield [path, en, tr]; return; }
  if (en && typeof en === "object") for (const k of Object.keys(en)) yield* strings((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
}
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

describe.each([["af", voiceAf, af], ["st", voiceSt, st], ["zu", voiceZu, zu]] as const)("%s voice copy", (_n, t, bundle) => {
  it("is the bundle's voice slice", () => expect(bundle.voice).toBe(t));
  it("translates every key, keeping placeholders", () => {
    const wrong: string[] = [];
    for (const [path, en, tr] of strings(voice, t)) {
      if (typeof tr !== "string" || !tr.trim()) wrong.push(`${path}: missing`);
      else if (placeholders(tr) !== placeholders(en)) wrong.push(`${path}: placeholders`);
    }
    expect(wrong).toEqual([]);
  });
});
