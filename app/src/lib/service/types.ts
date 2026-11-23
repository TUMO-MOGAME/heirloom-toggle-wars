/**
 * The one interface the UI talks to. Two implementations:
 *  - mock.ts  (owned by the UI/design agent): in-memory demo data, instant, used for design and as offline fallback
 *  - chain.ts (owned by the chain/agent backend): Solana devnet via the Anchor client, WDK signing, Gemini API routes
 * Selected in ./index.ts by NEXT_PUBLIC_DATA_MODE = "mock" | "chain".
 * Every write returns the tx signature (mock returns a fake one) so the UI can link Solana Explorer.
 */
import type {
  ActivityItem, AgentReport, Asset, Base58, CarValuation, Category, Claim, Estate, FxRate,
  Hardship, Offer, OfferRanking, PayeeKind, Payee, Rule, Beneficiary, WillChatMessage, WillDraft,
  PaymentReview, PaymentReceipt, SavedRecipient, Recurrence, FeeQuote, FeeQuoteInput,
} from "../types";
import type { Locale } from "../i18n/locales";
import type { LegacyBook, LegacySpeech, LegacyStatus, LegacyVoiceInfo } from "../legacy/schema";
import type { LegacyVoiceUpload, SpeakInput } from "../legacy/client";
import type { AssetKind, GuardiansService, GuardiansSnapshot } from "../guardians/types";
import type { Dispute, DisputesService } from "../disputes/types";
import type { BillDetails, BillPayee, BillPayeeInput, PaidBill } from "../bills/types";
import type { InvoiceRead } from "../bills/invoice";
import type { AskNote, AskService } from "../ask/types";
import type { TreeService } from "../tree/types";
import type { LettersService } from "../letters/types";
import type { AgentVoteInfo, ContinuityService, CreateEstateOptions } from "../continuity/types";

export interface TxResult { signature: string; explorerUrl: string }

/**
 * The offer, the exact amount and who gets the money, as on screen when a trusted person co-signs a sale (R19, H11):
 * an approved hardship changes the recipient, and a signature is never given on the old reading.
 */
export interface SeenOffer { offer: Base58; amount: bigint; recipient: Base58 }

export interface EstateSnapshot {
  estate: Estate;
  beneficiaries: Beneficiary[];
  payees: Payee[];
  rules: Rule[];
  claims: Claim[];
  assets: Asset[];
  offers: Offer[];
  hardships: Hardship[];
  activity: ActivityItem[];
  /** Guardians (seats, monitors, objections, fallback). Absent on older snapshots; `enabled: false` when no Guard exists. */
  guardians?: GuardiansSnapshot;
  /** Disputes (U9) on claims and on the unlock, newest first. Absent on older snapshots. */
  disputes?: Dispute[];
  /**
   * Off-chain display names by wallet that the service knows beyond the roles above (chain: the estate meta's
   * names and the names this device gave backups, monitors and fallback recipients). For the activity feed
   * (lib/people.ts); never on-chain, and dropped from the public record.
   */
  names?: Record<Base58, string>;
  /** "Ask for money" notes by claim address (purpose, the owner's decline; off-chain, lib/ask). Absent on older snapshots. */
  asks?: Record<Base58, AskNote>;
  /** Who a sweep pays: the named person, else the first living fallback recipient. Null: nobody yet. */
  residual?: Base58 | null;
  /** Open votes to replace the agent. Absent on older snapshots. */
  agentVotes?: AgentVoteInfo[];
  /** The owner's device (or the demo): the assets the signed plan describes, which signing doesn't register (M4). */
  plannedAssets?: WillDraft["assets"];
}

export interface HeirloomService extends GuardiansService, DisputesService, AskService, TreeService, LettersService, ContinuityService {
  mode: "mock" | "chain";

  // Reads
  getEstate(estate: Base58): Promise<EstateSnapshot>;
  listEstatesFor(wallet: Base58): Promise<{ estate: Base58; role: string; ownerName: string }[]>;
  getFx(): Promise<FxRate>;

  // AI agent (server routes)
  /** `locale` asks the agent to reply in the visitor's language. */
  willChat(history: WillChatMessage[], locale?: Locale): Promise<{ reply: string; draft: WillDraft | null }>;
  reviewDocument(input: { file: File; purpose: "death" | "claim" | "hardship"; context: string }): Promise<AgentReport>;
  /** Cars and motorbikes (lib/media/api.ts VALUED_KINDS); `kind` defaults to a car. */
  valueCar(input: { make: string; model: string; year: number; mileageKm: number; condition: string; kind?: AssetKind }): Promise<CarValuation>;
  rankOffers(asset: Base58): Promise<OfferRanking>;

  // Owner
  /** `topUpFailed`: the plan is signed, but the practice SOL for its people didn't go through (they can ask for starter funds). */
  createEstateFromWill(draft: WillDraft, opts?: CreateEstateOptions): Promise<{ estate: Base58; txs: TxResult[]; topUpFailed?: boolean }>;
  /**
   * The plan this wallet started signing and the chain doesn't have all of yet (H6), to finish with createEstateFromWill
   * (which skips what is there). Null when there is none.
   */
  unfinishedSigning(): Promise<{ draft: WillDraft; options: CreateEstateOptions } | null>;
  deposit(estate: Base58, amountUsdt: number): Promise<TxResult>;
  withdraw(estate: Base58, amountUsdt: number): Promise<TxResult>;
  heartbeat(estate: Base58): Promise<TxResult>;
  registerAsset(estate: Base58, input: { nftMint: Base58; title: string; floorUsdt: number; hardshipFloorUsdt: number; askingUsdt: number; proceedsTo: Base58; docFile?: File }): Promise<TxResult>;
  addPayee(estate: Base58, input: { wallet: Base58; kind: PayeeKind; name: string }): Promise<TxResult>;
  addRule(estate: Base58, input: { beneficiary: Base58; category: Category; allowedPayeeKind: PayeeKind; maxPerClaimUsdt: number; lifetimeCapUsdt: number; validUntil: number; startsNow: boolean; recurring?: { amountUsdt: number; intervalSecs: number; firstDue: number; payee: Base58; /** What the owner chose ("month"), kept to say it beside a fast clock. */ every?: Recurrence }; /** An ended rule whose slot to reuse. */ reuse?: Base58 }): Promise<TxResult>;
  /** Living plan: owner approves a claim on a startsNow rule while alive (counts as full approval). */
  ownerApproveClaim(estate: Base58, claim: Base58): Promise<TxResult>;
  /** Scheduled payment: anyone (UI button, agent, cron) triggers a due recurring payout. */
  /**
   * `shown`: the amount and payee on screen. A rule whose slot was reused since pays someone or something else, so it
   * is refused (code "ScheduleChanged") instead of paying what wasn't shown.
   */
  executeScheduled(estate: Base58, rule: Base58, shown?: { amount: bigint; payee: Base58 }): Promise<TxResult>;
  vetoDeath(estate: Base58): Promise<TxResult>;

  // Family
  submitDeathClaim(estate: Base58, certificate: File): Promise<{ tx: TxResult; report: AgentReport }>;
  submitClaim(estate: Base58, input: { rule: Base58; payee: Base58; amountUsdt: number; evidence: File }): Promise<{ tx: TxResult; claim: Base58; report: AgentReport }>;
  submitHardship(estate: Base58, input: { asset: Base58; evidence: File }): Promise<{ tx: TxResult; report: AgentReport }>;
  /**
   * The person who submitted a claim or hardship request asks for the agent's review again, after it did not finish
   * (H7). Only with the same file: its SHA-256 must be the one on-chain. A request sent without a letter needs none
   * (the app writes the same request note again). Nothing new is submitted.
   */
  requestReview(estate: Base58, input: { kind: "claim" | "hardship"; subject: Base58; evidence?: File | null }): Promise<{ tx: TxResult | null; report: AgentReport }>;

  // Verifiers
  attestDeath(estate: Base58): Promise<TxResult>;
  approveClaim(estate: Base58, claim: Base58): Promise<TxResult>;
  approveHardship(estate: Base58, hardship: Base58): Promise<TxResult>;

  // Anyone
  finalizeUnlock(estate: Base58): Promise<TxResult>;
  executeClaim(estate: Base58, claim: Base58): Promise<TxResult>;

  // Tether track payment flow (review → approve → WDK sign → pending → confirmed)
  /** Validates address/network/token, reads balances, quotes the fee. Nothing is signed. */
  /** `selfPay`: review what it costs when the user pays the fee (after the sponsor refused: code "FeeChanged"). */
  reviewSend(input: { to: Base58; toLabel: string; amountUsdt: number; bill?: BillDetails; selfPay?: boolean }): Promise<PaymentReview>;
  /**
   * The cost of a payment the contract makes (claims, schedules, offers, deposits), before it is approved (M3). The
   * payment then runs inside `withShownFee`, which never lets the user pay a fee the review said Heirloom pays.
   */
  quoteFee(estate: Base58, input: FeeQuoteInput): Promise<FeeQuote>;
  withShownFee<T>(fee: Pick<PaymentReview["fee"], "sponsored">, work: () => Promise<T>): Promise<T>;
  /** Signs + submits with WDK after the user approved `review`. Idempotent on review.id. */
  confirmSend(review: PaymentReview): Promise<PaymentReceipt>;
  /** Re-checks a payment by id (after reconnect / reload). Never re-sends if a signature exists. */
  getReceipt(id: string): Promise<PaymentReceipt | null>;
  listPendingReceipts(): Promise<PaymentReceipt[]>;
  /** People this wallet can send to: `estate`'s family and trusted people by name (chain; the demo always lists them), this device's wallets and people paid before. */
  savedRecipients(estate?: Base58): Promise<SavedRecipient[]>;

  // Pay a bill once (lib/bills, plan.md §13.2): from the signed-in wallet through reviewSend/confirmSend with `bill`.
  // Never from the vault. Payees are an off-chain address book for this wallet.
  billPayees(): Promise<BillPayee[]>;
  saveBillPayee(input: BillPayeeInput): Promise<BillPayee>;
  /** The AI reads an invoice photo or PDF (amount, payee, reference). The file is not stored; only its SHA-256 is returned. */
  readInvoice(file: File): Promise<InvoiceRead>;
  /** Bills this wallet paid (or is paying), newest first. */
  paidBills(): Promise<PaidBill[]>;

  // Car sale
  listAsset(estate: Base58, asset: Base58, durationSecs: number): Promise<TxResult>;
  /** `buyerName`: the name the family sees beside the offer and on the sale (off-chain; the owner's names win). */
  placeOffer(estate: Base58, asset: Base58, amountUsdt: number, buyerName?: string): Promise<TxResult>;
  withdrawOffer(estate: Base58, asset: Base58): Promise<TxResult>;
  /**
   * The trusted person signed in co-signs this exact offer, amount and recipient; the agent signs and pays. `null`: they
   * saw no acceptable offer (to read the contract's refusal), so one that has arrived since is never signed unread.
   */
  acceptBestOffer(estate: Base58, asset: Base58, seen?: SeenOffer | null): Promise<{ tx: TxResult; ranking: OfferRanking }>;

  // Legacy voice (lib/legacy/*): the owner's consented voice clone + Legacy Book; after unlock a child who opts in
  // hears the owner's own messages for moments in that voice.
  // Writes are owner-only; the voice id never reaches the browser. Mock: browser speech stands in, clearly labelled.
  /** `quiet`: a background read that must not ask for the PIN (chain: fails with code "locked" when it would). */
  legacyStatus(estate: Base58, opts?: { quiet?: boolean }): Promise<LegacyStatus>;
  /** Owner, while alive: spoken consent line + ticked box + ≥ 3 samples → Instant Voice Clone. */
  createLegacyVoice(estate: Base58, input: LegacyVoiceUpload): Promise<LegacyVoiceInfo>;
  /** Owner: deletes the voice everywhere (ElevenLabs too), with its recordings and rendered messages. */
  deleteLegacyVoice(estate: Base58): Promise<void>;
  saveLegacyBook(estate: Base58, book: LegacyBook): Promise<LegacyBook>;
  deleteLegacyBook(estate: Base58): Promise<void>;
  /** Child: switch the legacy voice on or off for themselves. */
  setLegacyOptIn(estate: Base58, on: boolean): Promise<void>;
  /**
   * Audio in the parent's voice for a milestone message the owner wrote (or the owner's fixed sample line), or
   * simulated text to speak locally. Never free text: no chat, no calls, no new words (plan §16.17).
   */
  legacySpeak(estate: Base58, input: SpeakInput): Promise<LegacySpeech>;
}
