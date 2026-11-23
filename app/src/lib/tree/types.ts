/**
 * Trust Tree (plan.md §15): the family's record of kept promises.
 *
 * The contract between the tree's logic/services (tree-core) and its screen (tree-ui).
 * Rules that every value of these types must keep:
 *  - No amounts, balances, prices or asset values anywhere (the tree is safe to show the whole family).
 *  - No scores or percentages. The only negative fact is an upheld challenge (`KeptKind` "challengeUpheld").
 *  - Names, relationships and years are off-chain personal data (POPIA). Only wallets, roles and actions come from
 *    the chain. The fingerprint hashes wallets/ids, relationships and edges, never names.
 *  - Copy is not stored here: the UI turns `kind` + fields into words from content/tree.ts.
 */
import type { Base58, HexHash } from "../types";
import type { AssetKind } from "../guardians/types";
import type { TxResult } from "../service/types";

/** A person id: a wallet address, or a local id ("local:<slug>") for someone without a wallet (e.g. grandparents). */
export type PersonId = string;

export interface TreePerson {
  id: PersonId;
  /** Full display name ("Thabo Mokoena"). Empty when hidden. */
  name: string;
  /** Short name for tight spaces ("Thabo"). Empty when hidden. */
  short: string;
  wallets: Base58[];
  /** Year of birth, if the family declared it. */
  born?: number;
  /** Year they passed: from the estate's unlock for an owner, else declared. */
  passed?: number;
  /** A living adult chose to hide: shown as "A family member", no name or card details; edges stay (roles are public on-chain). */
  hidden: boolean;
  /** Under 18: first name only, no card details. */
  minor: boolean;
  /** The year they first appear on the tree (born, or joined the family, or first role). */
  since: number;
  /** Generation row, 0 = oldest shown. Computed by derive; the UI may use it directly. */
  generation: number;
  /** The estate this person owns, if they have their own Heirloom plan. */
  ownsEstate?: Base58;
  /** An organisation (a charity named in the fallback plan), not a person: drawn as a square, no years. */
  org?: boolean;
  /** Their photo (plan.md §15.11): off-chain, never in the fingerprint, never for a hidden person. */
  photo?: TreePhoto;
}

/** A photo on the tree: a 256×256 WebP (or, in the demo, a bundled illustration). */
export interface TreePhoto {
  src: string;
  /** Who added it (a person id; the UI words it). */
  addedBy: PersonId;
  /** The year it was added. */
  year: number;
  /**
   * Added by someone else for a person who has passed or has no wallet: shown with "Added by {name}, {year}".
   * Not set for a living adult's own photo, a child's (the parent decides) or an organisation's logo.
   */
  memorial: boolean;
}

export type RelationshipKind = "parentOf" | "spouseOf" | "siblingOf";

export interface Relationship {
  id: string;
  kind: RelationshipKind;
  /** `from` is the parent for "parentOf"; order doesn't matter for spouse/sibling. */
  from: PersonId;
  to: PersonId;
  /** The owner wallet that declared it. */
  declaredBy: Base58;
  /** Unix seconds. */
  declaredAt: number;
}

export type TrustRole = "trustedPerson" | "guardian" | "heir" | "beneficiary" | "successor" | "monitor" | "fallback";

/** "Owner trusted person with role in estate" (derived from the chain). */
export interface TrustEdge {
  id: string;
  /** The owner who gave the trust. */
  from: PersonId;
  to: PersonId;
  role: TrustRole;
  estate: Base58;
  /** Unix seconds. */
  fromTs: number;
  /** Unix seconds; absent while it lasts. */
  toTs?: number;
  /** Kept promises along this edge (for line thickness). */
  keptCount: number;
}

export type KeptKind =
  | "confirmedPassing"     // trusted person / seat confirmed the owner's passing, and the unlock went through
  | "approvedPayments"     // trusted person / guardian approved claims
  | "answeredRequests"     // owner approved "ask for money" requests while alive
  | "planPaid"             // the plan paid by its rules (credited to the owner)
  | "helpedHardship"       // approvers of a hardship request
  | "guardianTerm"         // held a guardian seat from..to
  | "carriedOutFallback"   // carried out the owner's fallback plan
  | "raisedUpheldChallenge"// raised a challenge that was upheld (positive for the raiser)
  | "challengeUpheld";     // the only negative fact: a challenge against this person's claim was upheld

/** One kept promise, grouped: e.g. "approved 12 payments for Naledi, 2041–2049". */
export interface KeptPromise {
  id: string;
  kind: KeptKind;
  /** Who kept it. */
  by: PersonId;
  /** Who it was for (may be empty, e.g. confirmedPassing is for the owner in `about`). */
  for: PersonId[];
  /** The person the promise was about (e.g. the owner whose passing was confirmed). */
  about?: PersonId;
  estate: Base58;
  /** How many events this groups (payments approved, requests answered…). Never an amount. */
  count: number;
  /** For confirmedPassing: how many others confirmed too. */
  withOthers?: number;
  /** Rule purpose for planPaid / approvedPayments (a Category, e.g. "Tuition"); the UI words it. */
  purpose?: string;
  /** Unix seconds of the first and last event grouped. */
  firstTs: number;
  lastTs: number;
  /**
   * Unix seconds of each grouped event, oldest first (added by tree-core), so the timeline can count what was kept by
   * a year (lib/tree/timeline.ts). Optional: a promise without it counts in full from `firstTs`.
   */
  tss?: number[];
  /** Proof: transaction signatures (newest first, at most 5). Mock: simulated ids. */
  proofs: string[];
  /** True for events after "today" in the demo story (imagined future). Always false on chain. */
  imagined: boolean;
}

export type AssetStepKind = "registered" | "heldByPlan" | "passedTo" | "soldUnderRules";

export interface AssetStep {
  kind: AssetStepKind;
  /** Unix seconds. */
  ts: number;
  /** For passedTo: the heir. For soldUnderRules: never the buyer's name or the price, just that it was sold by the rules. */
  to?: PersonId;
  proof?: string;
  imagined: boolean;
}

/** An asset's path through the family, by kind only. No value, price or balance. */
export interface AssetPath {
  id: string;
  kind: AssetKind;
  /** Short, value-free title ("2017 Toyota Corolla"). */
  title: string;
  /** The owner whose plan held it. */
  owner: PersonId;
  estate: Base58;
  steps: AssetStep[];
}

/** A child's own plan attached below a parent's (off-chain for now). */
export interface GenerationLink {
  parentEstate: Base58;
  childEstate: Base58;
  /** The child (owner of childEstate). */
  person: PersonId;
  /** Unix seconds. */
  ts: number;
}

export interface TreeSnapshot {
  /** The estate the tree was opened from. */
  estate: Base58;
  mode: "mock" | "chain";
  people: TreePerson[];
  relationships: Relationship[];
  edges: TrustEdge[];
  kept: KeptPromise[];
  assets: AssetPath[];
  generations: GenerationLink[];
  /** The years the slider covers. */
  span: { from: number; to: number };
  /** "Today" on the slider (the current year; in the demo, events after it are imagined). */
  today: number;
  /** SHA-256 (hex) of the canonical tree: ids/wallets, relationships, edges. Never names. */
  fingerprint: HexHash;
  /** Chain: true when older history could not be loaded within the time budget. */
  partial: boolean;
}

/** What the tree looks like at a year on the slider (lib/tree/timeline.ts). */
export interface TreeAtYear {
  year: number;
  /** People present (since <= year); `passed` set only if passed <= year. */
  people: (TreePerson & { alive: boolean })[];
  relationships: Relationship[];
  /** Edges that had started by then; `keptCount` counts only promises kept by then. */
  edges: TrustEdge[];
  kept: KeptPromise[];
  /** Assets with only the steps reached by then. */
  assets: AssetPath[];
}

export interface RelationshipInput {
  kind: RelationshipKind;
  from: PersonId;
  to: PersonId;
}

/** Added to HeirloomService (lib/service/types.ts). Both mock and chain implement it. */
export interface TreeService {
  /** The family's Trust Tree, seen from this estate. Family only: the UI shows it to wallets with a role in the estate. */
  getTree(estate: Base58): Promise<TreeSnapshot>;
  /** Owner: declare a relationship (off-chain). */
  setRelationship(estate: Base58, input: RelationshipInput): Promise<Relationship>;
  /** Owner: remove a relationship they declared. */
  removeRelationship(estate: Base58, id: string): Promise<void>;
  /** A living adult hides or shows themselves on the tree (the signed-in wallet only). */
  setHidden(estate: Base58, hidden: boolean): Promise<void>;
  /**
   * Add or replace a photo (lib/tree/photos.ts photoConsent: a living adult their own; the owner for a child, someone
   * who has passed, someone without a wallet or an organisation). `src` is a WebP data URL of at most 60 KB.
   */
  setPhoto(estate: Base58, person: PersonId, src: string): Promise<void>;
  /** Remove a photo (same consent as setPhoto). */
  removePhoto(estate: Base58, person: PersonId): Promise<void>;
}

/** Re-exported so tree modules don't reach into the service folder for it. */
export type { TxResult };
