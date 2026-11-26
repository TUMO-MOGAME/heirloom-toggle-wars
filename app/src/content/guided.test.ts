/** Guided run copy: every key translated in af/st/zu with the same {placeholders} and marks, and a line for every step. */
import { describe, expect, it } from "vitest";
import { guided } from "./guided";
import { guidedAf, guidedSt, guidedZu } from "./i18n/guided";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";
import { GUIDED_STEPS } from "@/lib/guided/machine";

function* strings(en: unknown, tr: unknown, path = ""): Generator<[string, string, unknown]> {
  if (typeof en === "string") { yield [path, en, tr]; return; }
  if (en && typeof en === "object") for (const k of Object.keys(en)) yield* strings((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
}
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
const marks = (s: string) => (s.match(/\*/g) ?? []).length;

describe("English guided-run copy", () => {
  it("has a title and words for every step", () => {
    for (const id of GUIDED_STEPS) expect(guided.steps[id].title, id).toBeTruthy();
    expect(Object.keys(guided.steps)).toEqual([...GUIDED_STEPS]);
  });

  it("has three trusted people's roles for the signed plan", () => {
    expect(guided.draft.trustedRoles).toHaveLength(3);
    expect(guided.draft.summary).toMatch(/\{child\}.*\{perClaim\}.*\{total\}.*\{until\}/);
  });

  it("says the demo is simulated and devnet uses test money", () => {
    expect(guided.page.bodyMock).toMatch(/simulated/i);
    expect(guided.page.bodyChain).toMatch(/test money/);
  });
});

describe.each([["af", guidedAf, af], ["st", guidedSt, st], ["zu", guidedZu, zu]] as const)("%s guided-run copy", (_n, t, bundle) => {
  it("is the bundle's guided slice", () => expect(bundle.guided).toBe(t));

  it("translates every key, keeping placeholders, marks, USD₮, Heirloom and people's names", () => {
    const wrong: string[] = [];
    for (const [path, en, tr] of strings(guided, t)) {
      if (typeof tr !== "string" || !tr.trim()) { wrong.push(`${path}: missing`); continue; }
      if (placeholders(tr) !== placeholders(en)) wrong.push(`${path}: placeholders`);
      if (marks(tr) !== marks(en)) wrong.push(`${path}: marks`);
      for (const keep of ["Heirloom", "USD₮", "Lerato", "Thabo", "Solana", "SHA-256", "PIN"]) if (en.includes(keep) && !tr.includes(keep)) wrong.push(`${path}: ${keep}`);
      if (tr === en && en.length > 12 && !/^\{\w+\}$/.test(en)) wrong.push(`${path}: still English`);
    }
    expect(wrong).toEqual([]);
  });

  it("has three trusted people's roles", () => expect(t.draft.trustedRoles).toHaveLength(3));
});
