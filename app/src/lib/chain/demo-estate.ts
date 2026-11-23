/**
 * The seeded devnet demo estates: the Mokoena family, all fictional people.
 *
 * - DEVNET_DEMO_ESTATE (scripts/seed-guardians-assets.ts --owner thabo2, 17 Nov 2026) is the one the app opens: a fresh
 *   estate with a 5-minute waiting period (so a dispute window is 5 minutes) and no test rules. Thabo's estate as on
 *   the demo site, Active, with his 2017 Corolla and his motorbike (photos + spec sheets bundled with the app, see
 *   lib/service/demo-media.ts), trusted people with backups and a monitor, the fallback plan and a yearly cap.
 * - DEVNET_FIRST_META (scripts/seed-demo.ts, 11 Nov 2026) is the first demo estate: Unlocked, its 2019 Corolla sold
 *   on 13 Nov. It keeps its real history; the same children and trusted people belong to it, so it is listed second.
 * - Display names are off-chain. Without Supabase the server keeps them in memory only, so after a restart the laptop
 *   demo would show "Estate owner". These defaults fill that gap (db.ts preloads them; Supabase, when set, wins).
 * - The demo wallets also belong to a throwaway rehearsal estate (scripts/rehearse-devnet.ts), so a family member
 *   can be linked to more than one estate; the app opens the demo estate first.
 * Public addresses only. Devnet only: never used on mainnet.
 */
import type { EstateMeta } from "../db"; // type only: erased, so no server code reaches the browser
import type { FallbackRecipient } from "../guardians/types";
import type { DeclaredPerson } from "../tree/derive"; // type only
import type { RelationshipKind } from "../tree/types";

export const DEVNET_DEMO_ESTATE = "J6WCQvgkJmzYQXjo37GLktZnFB9nbpwCchkCVKbcKMaj";
/** Thabo's devnet wallet (persona `thabo2`), the demo estate's owner. */
const OWNER = "4uQxH9yp9bajHRuR2rNuiTedsJ9DcrDqCZzpXc6Fu96Y";

/** The demo children's public wallets (for the demo Legacy Book and the fallback plan). */
export const DEVNET_DEMO_CHILDREN = {
  lerato: "FXb3FikjwrPU8nR8WjJB6y4LCZ1esdw3vkUybPwMvGZZ",
  sipho: "BMiTCRtWEettDpHQvL9kBt5bkSpiNeAMZYwYUmaAybbV",
  naledi: "7MC44yaTaRQCxW3aSnzfr2deQzWw3yvw4XnrmpUewirD",
};

/** Guardians of the demo estate: Uncle Bongani's backups and monitor, and the last fallback recipient. */
export const DEVNET_DEMO_GUARDIANS = {
  zodwa: "7dQdV9XwL5Xj3KAujXNmwazj9Lz53rpQR7mkLvLMBTFN",
  kagiso: "9dkk7k8yUiVq7dpDWYXbVpwozzBnUC1UsEWxaQtF9ViZ",
  priya: "GB1bR7hHMyos7dBoKdSAn71cWZ2cVanVxETqWvsQm9X",
  charity: "CohBpTeh3uiGMpMZD9gA1Ej88x4JMMcjKtbg27FcDMfU",
};

const VERIFIER_NAMES: EstateMeta["verifierNames"] = ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"];
const BUYERS = { "12eMQwGSR57E2wKRt8Uwn18DWaN54GKY7HGJD8zTLaV8": "Pieter", "6n4djkebGKjD7jyJ3gGNorgPkh73bwmV1tpfRAA538F7": "Ayesha" };

export const DEVNET_DEMO_META: EstateMeta = {
  estate: DEVNET_DEMO_ESTATE,
  ownerWallet: OWNER,
  ownerName: "Thabo Mokoena",
  verifierNames: VERIFIER_NAMES,
  // Keyed by title NFT mint.
  assetTitles: {
    DqMKvrGcZbWhwPYG6iPuij3o365tWa18JEnBjjrTVo16: "2017 Toyota Corolla 1.8 Exclusive CVT",
    F3dSMhHDzrTrimJ85KechpoTuWRaf6q8xHDdfLMoJF6J: "2025 Big Boy Mustang 250",
  },
  // Names by wallet (buyers, and the guardians view's people), as on the demo site.
  buyerNames: {
    ...BUYERS,
    [DEVNET_DEMO_CHILDREN.lerato]: "Lerato (daughter)",
    [DEVNET_DEMO_CHILDREN.sipho]: "Sipho (son)",
    [DEVNET_DEMO_CHILDREN.naledi]: "Naledi (daughter)",
    [DEVNET_DEMO_GUARDIANS.zodwa]: "Aunt Zodwa Mokoena",
    [DEVNET_DEMO_GUARDIANS.kagiso]: "Cousin Kagiso Mokoena",
    [DEVNET_DEMO_GUARDIANS.priya]: "Adv. Priya Naidoo",
    [DEVNET_DEMO_GUARDIANS.charity]: "Ithemba Children's Charity",
  },
};

/** The demo estate's three trusted people on devnet (Adv. Ndlovu, Ms. Pillay, Uncle Bongani), as on the Estate account. */
export const DEVNET_DEMO_VERIFIERS = {
  ndlovu: "7bNTXFYv3ZGDu7H8JJBtarkzhrFUBLNpQ5PptctsYpoi",
  pillay: "8NCbN1YkHje1m4twHXYhWoaaHjbNVwqqwePNyc6Ag21t",
  bongani: "8HfJudydqE1FThWmuY2cPk9vqvfQd23E7DdaEsxwQpzM",
};

/**
 * The Trust Tree's default family for the demo estate (plan.md §15.5), so the devnet tree is not flat: the same
 * fictional Mokoena family as the demo site, with full names and birth years (off-chain only; never on-chain).
 * Thabo's parents have no wallet (local ids). The owner can add or remove relationships on the tree.
 */
export const DEVNET_DEMO_FAMILY: { people: DeclaredPerson[]; relationships: { kind: RelationshipKind; from: string; to: string }[] } = {
  people: [
    { id: "local:mkhulu-joseph", name: "Mkhulu Joseph Mokoena", born: 1936, passed: 2003 },
    { id: "local:gogo-martha", name: "Gogo Martha Mokoena", born: 1941, passed: 2019 },
    { id: DEVNET_DEMO_VERIFIERS.bongani, name: "Uncle Bongani Mokoena", born: 1971 },
    { id: OWNER, name: "Thabo Mokoena", born: 1976 },
    { id: DEVNET_DEMO_GUARDIANS.zodwa, name: "Aunt Zodwa Mokoena", born: 1979 },
    { id: DEVNET_DEMO_GUARDIANS.kagiso, name: "Cousin Kagiso Mokoena", born: 1998 },
    { id: DEVNET_DEMO_CHILDREN.lerato, name: "Lerato Mokoena", born: 2006 },
    { id: DEVNET_DEMO_CHILDREN.sipho, name: "Sipho Mokoena", born: 2008 },
    { id: DEVNET_DEMO_CHILDREN.naledi, name: "Naledi Mokoena", born: 2011 },
    { id: DEVNET_DEMO_VERIFIERS.ndlovu, name: "Adv. Thandi Ndlovu" },
    { id: DEVNET_DEMO_VERIFIERS.pillay, name: "Ms. Anita Pillay" },
    { id: DEVNET_DEMO_GUARDIANS.priya, name: "Adv. Priya Naidoo" },
    { id: DEVNET_DEMO_GUARDIANS.charity, name: "Ithemba Children's Charity" },
  ],
  relationships: [
    { kind: "spouseOf", from: "local:mkhulu-joseph", to: "local:gogo-martha" },
    ...[DEVNET_DEMO_VERIFIERS.bongani, OWNER, DEVNET_DEMO_GUARDIANS.zodwa].flatMap((child) => [
      { kind: "parentOf" as const, from: "local:mkhulu-joseph", to: child },
      { kind: "parentOf" as const, from: "local:gogo-martha", to: child },
    ]),
    ...Object.values(DEVNET_DEMO_CHILDREN).map((child) => ({ kind: "parentOf" as const, from: OWNER, to: child })),
    { kind: "parentOf", from: DEVNET_DEMO_VERIFIERS.bongani, to: DEVNET_DEMO_GUARDIANS.kagiso },
  ],
};

/** What each fallback recipient is (on-chain only the wallets are kept): the three children, then the charity. */
export const DEVNET_DEMO_FALLBACK_KINDS: Record<string, FallbackRecipient["kind"]> = {
  [DEVNET_DEMO_CHILDREN.lerato]: "family",
  [DEVNET_DEMO_CHILDREN.sipho]: "family",
  [DEVNET_DEMO_CHILDREN.naledi]: "family",
  [DEVNET_DEMO_GUARDIANS.charity]: "charity",
};

/** The previous guardians demo estate (owner `thabo`, 15 Nov 2026): Active; it carries the Avbob test rule. */
export const DEVNET_PREV_META: EstateMeta = {
  ...DEVNET_DEMO_META,
  estate: "2LXvcYbqbtZND3qrfKPex9N7Red3kvPAGDReXWdxymP7",
  ownerWallet: "HLbTQFbswmWRUg4ytvHsubKkvnP5fRc2JHZfsTkV7AN1",
  assetTitles: {
    HQAM3uebocQvVWCgEUJrKiUexu3DTrexL68LrwtPE6jW: "2017 Toyota Corolla 1.8 Exclusive CVT",
    GJ2tvFqYgPJz6j9PtK8Ri3C9X16hYw9DLvs5tFNT6qxP: "2025 Big Boy Mustang 250",
  },
};

/** The first demo estate (owner `dad`): Unlocked, 2019 Corolla sold. */
export const DEVNET_FIRST_META: EstateMeta = {
  estate: "JBdsDy67YBfpV8YAc2H1h7w95h8uJ2XUzTDh9vt34G9E",
  ownerWallet: "4Rd7m3i1etN66EbuLzTwkXU9dJKwwayBGg5jCyvTA5Tz",
  ownerName: "Thabo Mokoena",
  verifierNames: VERIFIER_NAMES,
  assetTitles: { F9FVooHEzRu92UXDmeUTNK7c1Wxgxi6xwWBRjqub5fLm: "2019 Toyota Corolla 1.8 Prestige" },
  buyerNames: BUYERS,
};

/**
 * Thabo is fictional, so nobody's voice can be cloned for him: the demo legacy voice is a stock ElevenLabs voice
 * ("Andreas - Warm & Welcoming", South African English), standing in for the Instant Voice Clone a real parent
 * records with consent. Override with LEGACY_DEMO_VOICE_ID.
 */
export const DEVNET_DEMO_LEGACY_VOICE = "rqZosEnZTsroRdHl7GGT";

/** Puts the demo estate first when a wallet belongs to several estates. */
export function demoEstateFirst<T extends { estate: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.estate === DEVNET_DEMO_ESTATE) - Number(a.estate === DEVNET_DEMO_ESTATE));
}
