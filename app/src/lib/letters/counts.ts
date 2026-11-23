/**
 * The Trust Tree card's letters line (plan.md §16.9): "2 letters from Thabo", counted up to the slider's year. Only
 * opened letters are counted (the service sends no others), never their text; a family letter counts for everyone
 * the writer named as a family member in their plan. Hidden people and children get no line. Counts are fetched
 * after the tree has drawn and are not part of the snapshot, so they never change its fingerprint.
 */
import type { LetterCount } from "./types";
import type { PersonId, TreePerson, TrustEdge } from "../tree/types";

export interface LettersLine { from: PersonId; count: number; imagined: boolean }

export function lettersLineFor(counts: LetterCount[], person: Pick<TreePerson, "id" | "wallets" | "hidden">, edges: Pick<TrustEdge, "from" | "to" | "role">[], year: number, minor: boolean): LettersLine[] {
  if (person.hidden || minor) return [];
  const mine = (w: string) => w === person.id || person.wallets.includes(w);
  const family = (from: string) => edges.some((e) => e.from === from && mine(e.to) && (e.role === "beneficiary" || e.role === "heir"));
  const out = new Map<PersonId, LettersLine>();
  for (const c of counts) {
    if (c.year > year) continue;
    if (!(c.to === "family" ? family(c.from) : mine(c.to))) continue;
    const line = out.get(c.from) ?? { from: c.from, count: 0, imagined: false };
    line.count += 1;
    line.imagined ||= !!c.imagined;
    out.set(c.from, line);
  }
  return [...out.values()];
}
