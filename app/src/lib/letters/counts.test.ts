/** The Trust Tree card's letters line: counts by year, none for hidden people or children, never in the fingerprint. */
import { describe, expect, it } from "vitest";
import { lettersLineFor } from "./counts";

const THABO = "ThAbOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", NALEDI = "NaLeDiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", SIPHO = "SiPhOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const edges = [{ from: THABO, to: NALEDI, role: "beneficiary" as const }, { from: THABO, to: SIPHO, role: "beneficiary" as const }];
const counts = [
  { from: THABO, to: "family" as const, year: 2026 },
  { from: THABO, to: NALEDI, year: 2029, imagined: true as const },
  { from: THABO, to: SIPHO, year: 2030 },
];
const naledi = { id: NALEDI, wallets: [NALEDI], hidden: false };

describe("letters line on the tree card", () => {
  it("counts the person's letters up to the slider's year, family letters included", () => {
    expect(lettersLineFor(counts, naledi, edges, 2026, false)).toEqual([{ from: THABO, count: 1, imagined: false }]);
    expect(lettersLineFor(counts, naledi, edges, 2029, false)).toEqual([{ from: THABO, count: 2, imagined: true }]);
    expect(lettersLineFor(counts, { id: SIPHO, wallets: [SIPHO], hidden: false }, edges, 2031, false)).toEqual([{ from: THABO, count: 2, imagined: false }]);
  });
  it("shows nothing for a hidden person or a child, and nothing to people outside the plan for family letters", () => {
    expect(lettersLineFor(counts, { ...naledi, hidden: true }, edges, 2040, false)).toEqual([]);
    expect(lettersLineFor(counts, naledi, edges, 2040, true)).toEqual([]);
    expect(lettersLineFor(counts, { id: "x", wallets: ["x"], hidden: false }, edges, 2040, false)).toEqual([]);
  });
});
