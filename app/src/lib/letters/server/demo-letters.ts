import "server-only";
/**
 * The seeded devnet demo estate's letters (plan.md §16.11): L1 "For all of you" and L2 "About the Corolla" (locked
 * until unlock, so only Thabo sees them), L5 "About Mkhulu Joseph" (open since 18 Nov 2026, so the children can read
 * it) and L3 "For your 18th birthday" for Naledi. L3 opens with her 500 USD₮ birthday gift rule when the estate has
 * it (scripts/seed-letter-gift.ts), else on her birthday, 14 Aug 2029. Returned under stored rows: a stored row,
 * including a tombstone, wins. Unsigned (`sig: null`), so the page says "Demo letter".
 */
import type { EstateSnapshot } from "@/lib/service/types";
import type { Base58 } from "@/lib/types";
import { toBase } from "@/lib/format";
import { DEVNET_DEMO_CHILDREN, DEVNET_DEMO_ESTATE } from "@/lib/chain/demo-estate";
import { demoLetters } from "../demo";
import type { Letter } from "../types";

/** Naledi's birthday gift as seeded on devnet: General, Other, 500 USD₮ to her own wallet. */
export function devnetGiftRule(snap: EstateSnapshot): Base58 | undefined {
  return snap.rules.find((r) => r.beneficiary === DEVNET_DEMO_CHILDREN.naledi && r.recurringAmount === toBase(500)
    && r.fixedPayee === DEVNET_DEMO_CHILDREN.naledi)?.address;
}

export async function seededLetters(estate: Base58, snap: EstateSnapshot): Promise<Letter[]> {
  if (estate !== DEVNET_DEMO_ESTATE) return [];
  return demoLetters({
    estate, owner: snap.estate.owner, lerato: DEVNET_DEMO_CHILDREN.lerato, naledi: DEVNET_DEMO_CHILDREN.naledi,
    corolla: snap.assets.find((a) => /corolla/i.test(a.title))?.address,
    giftRule: devnetGiftRule(snap),
    // Linked before the rule's first payment (14 Aug 2029), so any payment under it opens the letter.
    giftBaseline: "0",
  });
}

/** Stored rows over the seeded ones (a stored tombstone hides a seeded letter). */
export function withSeeded(stored: Letter[], seeded: Letter[]): Letter[] {
  const ids = new Set(stored.map((l) => l.id));
  return [...stored, ...seeded.filter((l) => !ids.has(l.id))];
}
