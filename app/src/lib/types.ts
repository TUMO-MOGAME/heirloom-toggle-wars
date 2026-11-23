/**
 * Shared domain types. The UI and the chain/agent layers both build against this file.
 * Mirrors docs/program-spec.md. Amounts are USD₮ base units (6 decimals) as bigint;
 * use helpers in lib/format.ts for display. Times are unix seconds.
 * Do not change shapes without updating docs/program-spec.md and both service implementations.
 */
import type { YearlyCap } from "./disputes/types";
import type { BillDetails } from "./bills/types";

export type Base58 = string;
export type HexHash = string; // 64 hex chars, sha256

export type EstateStatus = "Active" | "DeathPending" | "Unlocked" | "Frozen";
export type Category = "Tuition" | "Accommodation" | "Books" | "Medical" | "General";
export type PayeeKind = "University" | "School" | "Landlord" | "Other";
export type Verdict = "Pending" | "Approved" | "Rejected" | "Referred";
export type ClaimStatus = "Open" | "Paid" | "Rejected";
export type AssetStatus = "Held" | "Listed" | "Sold";
export type HardshipStatus = "Open" | "Approved" | "Rejected";

/** "monitor": watches a trusted person's approvals and may object (docs/guardians-spec.md). */
export type Role = "owner" | "beneficiary" | "verifier" | "buyer" | "agent" | "monitor";

export interface Estate {
  address: Base58;
  owner: Base58;
  ownerName: string; // off-chain display name
  agent: Base58;
  usdtMint: Base58;
  verifiers: [Base58, Base58, Base58];
  verifierNames: [string, string, string];
  deathThreshold: number;
  claimThreshold: number;
  hardshipThreshold: number;
  waitingPeriodSecs: number;
  status: EstateStatus;
  willHash: HexHash | null;
  vaultBalance: bigint;
  death: {
    certHash: HexHash | null;
    submittedBy: Base58 | null;
    verdict: Verdict;
    attestations: boolean[]; // index = verifier index
    /**
     * The only trusted person left was the one who reported it, and confirmed it alone (bit 7 of death_attestations,
     * DECIDED_ALONE): the unlock then waits twice the waiting period. Not a seat's vote.
     */
    decidedAlone?: boolean;
    /** When the quorum confirmed the death. Null while Active, also when a claim is open (see submittedAt). */
    pendingSince: number | null;
    /** Active with an open claim: when it was submitted (0 = before times were stored). See death-rules.ts. */
    submittedAt?: number | null;
    /** The agent's review of the death certificate (off-chain JSON; its hash is in the DeathReviewed event). */
    agentReport?: AgentReport;
  };
  lastHeartbeat: number;
}

export interface Beneficiary {
  address: Base58; // PDA
  wallet: Base58;
  label: string; // e.g. "Lerato (daughter)"
  active: boolean;
}

export interface Payee {
  address: Base58;
  wallet: Base58;
  kind: PayeeKind;
  name: string; // e.g. "University of Cape Town"
}

/** How often a scheduled payment repeats ("minute" exists for demos). */
export type Recurrence = "minute" | "week" | "month" | "term" | "year";

export interface Rule {
  address: Base58;
  id: number;
  beneficiary: Base58; // wallet
  category: Category;
  allowedPayeeKind: PayeeKind;
  maxPerClaim: bigint;
  lifetimeCap: bigint;
  spentTotal: bigint;
  validUntil: number;
  /** Living plan: true = rule works now, while the owner is alive (owner approval suffices); false = only after death unlock. */
  startsNow: boolean;
  /** Scheduled payment: >0 = pay this amount to fixedPayee every intervalSecs (no claim needed). */
  recurringAmount: bigint;
  intervalSecs: number;
  nextDue: number | null;
  fixedPayee: Base58 | null;
  /**
   * The interval the owner signed ("month"), when it is known apart from intervalSecs: the demo runs schedules on a
   * fast demo clock (60 s), so the signed plan must not read "every minute". The mock keeps it from the will draft;
   * chain accounts don't store it (chain rules fall back to the interval in seconds).
   */
  every?: Recurrence;
  /** Optional cap per 12-month period (e.g. school fees up to N a year), on top of the per-claim and lifetime caps. */
  yearlyCap?: YearlyCap | null;
  /** Next claim id. Its high 16 bits say which rule holds a reused slot (death-rules.ts isCurrentClaim). */
  claimCount?: number;
}

export interface Claim {
  address: Base58;
  rule: Base58;
  id: number;
  beneficiary: Base58;
  payee: Base58; // wallet
  amount: bigint;
  evidenceHash: HexHash;
  agentVerdict: Verdict;
  agentReport?: AgentReport;
  approvals: boolean[];
  /**
   * The only trusted person left was the claimant, and approved it alone (bit 7 of approvals, DECIDED_ALONE): its
   * objection window is then twice as long. Not a seat's vote.
   */
  decidedAlone?: boolean;
  /** Living plan: the owner approved this claim himself while alive (counts as full approval). */
  ownerApproved: boolean;
  status: ClaimStatus;
  createdAt: number;
  txSignature?: string;
  /** Made under a rule that held this slot before it was reused: can never be approved by the owner or paid. */
  fromEndedRule?: boolean;
  /** False: the trusted people's approvals predate the death, so they don't count and can be given again. */
  approvalsCount?: boolean;
}

export interface Asset {
  address: Base58;
  nftMint: Base58;
  title: string; // e.g. "2019 Toyota Corolla 1.8 Prestige"
  imageUrl?: string;
  floorPrice: bigint;
  hardshipFloor: bigint;
  askingPrice: bigint;
  proceedsTo: Base58;
  status: AssetStatus;
  listingEnds: number | null;
  docHash: HexHash;
  hardshipBeneficiary: Base58 | null;
}

export interface Offer {
  address: Base58;
  asset: Base58;
  buyer: Base58;
  buyerName?: string;
  amount: bigint;
  createdAt: number;
}

export interface Hardship {
  address: Base58;
  asset: Base58;
  beneficiary: Base58;
  evidenceHash: HexHash;
  agentVerdict: Verdict;
  agentReport?: AgentReport;
  approvals: boolean[];
  status: HardshipStatus;
}

/** What the AI agent returns after reading a document. Its hash goes on-chain. */
export interface AgentReport {
  verdict: "approve" | "reject" | "needs_human";
  documentType: string; // "death_certificate" | "fee_statement" | "affidavit" | ...
  extracted: Record<string, string>;
  redFlags: string[];
  confidence: number; // 0..1
  summary: string; // plain language, shown to verifiers
  reportHash: HexHash;
}

/** Structured will produced by the will-writer agent, reviewed and signed by the owner. */
export interface WillDraft {
  ownerName: string;
  beneficiaries: { label: string; relationship: string; wallet?: Base58 }[];
  verifiers: { name: string; role: string; wallet?: Base58 }[];
  rules: {
    beneficiaryLabel: string;
    category: Category;
    allowedPayeeKind: PayeeKind;
    maxPerClaimUsdt: number;
    lifetimeCapUsdt: number;
    validUntil: string; // ISO date
    notes: string;
    startsNow: boolean; // living plan (pay while alive) vs legacy (after death)
    recurring?: { amountUsdt: number; every: Recurrence; payeeName: string };
  }[];
  assets: {
    title: string;
    floorPriceUsdt: number;
    hardshipFloorUsdt: number;
    askingPriceUsdt: number;
    proceedsTo: string; // label or wallet
    hardshipPolicy: string;
  }[];
  waitingPeriodDays: number;
  plainLanguageSummary: string;
}

export interface WillChatMessage {
  role: "user" | "agent";
  text: string;
}

export interface CarValuation {
  suggestedAskingUsdt: number;
  lowUsdt: number;
  highUsdt: number;
  comparables: { title: string; priceZar: number; source: string; url?: string }[];
  rationale: string;
  /** True when no live listings were checked (the time budget ran out): the figures are Heirloom's own estimate. */
  estimate?: boolean;
}

export interface OfferRanking {
  bestOffer: Base58 | null;
  eligible: { offer: Base58; amount: bigint; reason: string }[];
  /** `readyAt`: acceptable from then, once its objection window (or the hardship approval's) has passed. */
  ineligible: { offer: Base58; amount: bigint; reason: string; readyAt?: number }[];
}

export interface ActivityItem {
  ts: number;
  kind: string; // event name, e.g. "ClaimPaid"
  text: string;
  amount?: bigint;
  txSignature?: string;
  /** For *Reviewed events: the agent report hash, to join the off-chain report. */
  reportHash?: HexHash;
  /** For AssetSold: which asset, who bought it and where the money went (from the event; no personal data). */
  sale?: SaleRecord;
  /**
   * Wallets that `text` names by their short address (chain events). The feed shows each as the person's name when
   * the app knows it (lib/people.ts), else the short address. Demo lines carry names in `text` and leave this out.
   */
  parties?: Base58[];
  /**
   * For payments out of the vault (ClaimPaid, ScheduledPaid, FallbackExecuted): who was paid and under which rule or
   * claim (from the event's fields). The monthly statement (lib/everyday/statement.ts) joins these to the rules.
   */
  payment?: PaymentRef;
  /** For RuleReused: the slot's rule address, which a new rule now holds (payments before it were the old rule's). */
  reusedRule?: Base58;
}

/** A vault payment's payee and, when the event names them, its rule and claim. */
export interface PaymentRef { payee: Base58; rule?: Base58; claim?: Base58 }

export interface SaleRecord {
  asset: Base58;
  buyer: Base58;
  /** Display name, when the app knows it (demo, or an off-chain profile). */
  buyerName?: string;
  recipient: Base58;
  hardship: boolean;
}

export interface FxRate {
  usdtZar: number;
  source: string; // e.g. "VALR" or "fallback"
  fetchedAt: number;
}

/**
 * Tether track payment flow (Mobile Money & P2P): validate → balance + fee quote → review (approve/cancel)
 * → WDK signs + submits → receipt pending → confirmed. Every USD₮ movement the user initiates goes through this.
 */
export interface PaymentReview {
  id: string; // idempotency key, generated before signing; reused on retry so nobody pays twice
  kind: "p2p" | "bill" | "vault-deposit" | "offer" | "claim-payout" | "scheduled" | "program";
  from: Base58;
  to: Base58;
  toLabel: string; // "Lerato (daughter)", "University of Cape Town"
  amount: bigint; // USD₮ base units
  token: { symbol: "USD₮"; mint: Base58; verified: boolean }; // verified = matches the configured USD₮ mint
  network: { name: string; cluster: "devnet" | "mainnet-beta" | "localnet" };
  /**
   * What it costs in SOL and who pays. `lamports` is everything the payer pays (network fee and, when it pays it, rent).
   * `networkLamports` and `rentLamports` split it when known; rent for a new account may be paid by someone else
   * (`rentPayer`) than the network fee.
   */
  fee: { lamports: number; sol: number; payer: Base58; sponsored: boolean; networkLamports?: number; rentLamports?: number; rentPayer?: Base58 };
  balances: { usdt: bigint; sol: number; sufficient: boolean };
  warnings: string[]; // e.g. "Recipient has no USD₮ account yet — it will be created (small SOL fee)"
  simulated?: boolean; // label on screen when any part is simulated
  /** kind "bill": who it pays, the reference and how the invoice compared (lib/bills). */
  bill?: BillDetails;
}

/** What a payment the estate's contract makes (or a program action) will cost, quoted before it is approved (M3). */
export interface FeeQuote {
  fee: PaymentReview["fee"];
  /** Lamports the user's wallet pays. */
  userLamports: number;
  /** The user's SOL now. */
  solBalance: number;
}

export interface FeeQuoteInput {
  kind: PaymentReview["kind"];
  /** The payee (claim, schedule), the asset (offer), the estate (deposit). */
  to: Base58;
  amount: bigint;
  /** A claim approved in the same go: by the living owner, or by a trusted person (whose approval may write a stamp). */
  approve?: "owner" | "verifier";
  claim?: Base58;
  /** Quote what the user pays when Heirloom can't (after "FeeChanged"). */
  selfPay?: boolean;
}

export type PaymentStatus = "draft" | "awaiting-approval" | "signing" | "submitted" | "pending" | "confirmed" | "failed" | "cancelled";

export interface PaymentReceipt {
  id: string; // same idempotency key as the review
  status: PaymentStatus;
  signature?: string;
  explorerUrl?: string;
  confirmations?: number;
  error?: string; // human-readable, with a recovery hint
  /** Why it was not signed, when the app knows: "FeeChanged" (the fee shown can't be kept, so it is shown again). */
  code?: string;
  updatedAt: number;
}

export interface SavedRecipient {
  label: string;
  address: Base58;
  relationship?: string;
}

/** A WDK-backed wallet session in the browser. */
export interface WalletSession {
  address: Base58;
  label: string;
  role: Role;
  solBalance: number;
  usdtBalance: bigint;
  /** True once the balances were really read (until then they show as zero). */
  balanceKnown?: boolean;
  /** Which wallet signs for this session: Heirloom's Tether WDK wallet (default) or a phone wallet (Wallet Standard / MWA). */
  source?: "wdk" | "phone";
  /** Phone wallets: the Wallet Standard name of the wallet app ("Mobile Wallet Adapter", "Phantom", ...). */
  phoneWallet?: string;
  /** Demo mode's simulated phone wallet: nothing real signs. */
  simulated?: boolean;
}
