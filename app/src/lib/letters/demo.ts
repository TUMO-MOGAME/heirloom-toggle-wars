/**
 * The demo story's letters (plan.md §16.11), shared by the mock service and the seeded devnet estate
 * (lib/letters/server/demo-letters.ts). All written by Thabo on 18 Nov 2026; their words live in content/letters.ts
 * `demo.*` so the demo reads in every language. Seeded letters carry no signature (`sig: null`) and say so.
 * Mkhulu Joseph (died 2003) gets no words of his own: L5 is Thabo's letter about him.
 */
import { letters as copy } from "@/content/letters";
import type { Base58 } from "../types";
import { letterHash } from "./canonical";
import type { DemoLetterKey, Letter, LetterInput } from "./types";

/** When the demo letters were written: 18 Nov 2026, 09:00 SAST. */
export const DEMO_WRITTEN_AT = Date.UTC(2026, 10, 18, 7) / 1000;
/** Naledi's 18th birthday, when her gift rule first pays. */
export const NALEDI_BIRTHDAY = "2029-08-14";

export const DEMO_LETTER_IDS: Record<DemoLetterKey, string> = {
  family: "ltr_DemoAAAAAAAAAAA1",
  lerato: "ltr_DemoAAAAAAAAAAA2",
  naledi: "ltr_DemoAAAAAAAAAAA3",
  mkhulu: "ltr_DemoAAAAAAAAAAA5",
};

export interface DemoLetterCast {
  estate: Base58;
  owner: Base58;
  lerato: Base58;
  naledi: Base58;
  /** The Corolla's asset address, when the estate has it. */
  corolla?: Base58;
  /** Naledi's 500 USD₮ birthday gift rule, when the estate has it (else L3 opens on her birthday). */
  giftRule?: Base58;
  /** The gift rule's spent_total when the letter was linked (base units). */
  giftBaseline?: string;
}

/** The inputs of the story letters L1, L2, L3 and L5 (L4, Lerato's letter to Amahle, has no text: counts only). */
export function demoLetterInputs(c: DemoLetterCast): Record<DemoLetterKey, LetterInput> {
  const words = (k: DemoLetterKey) => ({ occasion: copy.demo[k].occasion, text: copy.demo[k].text });
  return {
    family: { id: DEMO_LETTER_IDS.family, to: { kind: "family" }, opens: { kind: "unlock" }, ...words("family") },
    lerato: { id: DEMO_LETTER_IDS.lerato, to: { kind: "person", wallet: c.lerato }, opens: { kind: "unlock" }, ...words("lerato"), ...(c.corolla ? { about: { asset: c.corolla } } : {}) },
    naledi: {
      id: DEMO_LETTER_IDS.naledi, to: { kind: "person", wallet: c.naledi },
      opens: c.giftRule ? { kind: "payment", rule: c.giftRule } : { kind: "date", on: NALEDI_BIRTHDAY }, ...words("naledi"),
    },
    mkhulu: { id: DEMO_LETTER_IDS.mkhulu, to: { kind: "family" }, opens: { kind: "date", on: "2026-11-18" }, ...words("mkhulu") },
  };
}

/** The seeded letters as stored: version 1, unsigned, written 18 Nov 2026. */
export async function demoLetters(c: DemoLetterCast): Promise<Letter[]> {
  const inputs = demoLetterInputs(c);
  return Promise.all((Object.keys(inputs) as DemoLetterKey[]).map(async (k) => {
    const input = inputs[k];
    return {
      ...input, estate: c.estate, from: c.owner, version: 1, hash: await letterHash(c.estate, c.owner, input, 1), sig: null,
      signedAt: DEMO_WRITTEN_AT * 1000, createdAt: DEMO_WRITTEN_AT, updatedAt: DEMO_WRITTEN_AT, openedAt: null, demoKey: k,
      ...(input.opens.kind === "payment" ? { baseline: c.giftBaseline ?? "0" } : {}),
    } satisfies Letter;
  }));
}
