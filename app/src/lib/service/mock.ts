/**
 * In-memory demo implementation of HeirloomService.
 * It behaves like the Solana program in docs/program-spec.md: the same checks, the same error names,
 * so the UI can be designed, demoed and recorded without a network. State survives reloads (localStorage).
 *
 * Extras beyond the interface (see MockService) let the UI tell the mock who is acting and jump the
 * demo to a later stage. The UI only uses them when `mode === "mock"`.
 */
import { explorerTx, fromBase, toBase } from "../format";
import { amountsInText } from "../amount";
import { requireEvidence } from "../evidence";
import type {
  AgentReport, Asset, Base58, Claim, Hardship, Offer, OfferRanking, PayeeKind, PaymentReceipt, PaymentRef, PaymentReview, Role, Rule, SavedRecipient, WillChatMessage, WillDraft,
} from "../types";
import type { EstateSnapshot, HeirloomService, TxResult } from "./types";
import { DEMO_PERSONAS as WALLET_PERSONAS } from "../wallet/personas";
import { createMockLegacy } from "./mock-legacy";
import { fail } from "./mock-errors";
import { blankGuard, createMockGuardians, VACANT_KEY, type FallbackInput, type MockGuardState, type Named } from "./mock-guardians";
import { createMockDisputes } from "./mock-disputes";
import { DEMO_PAYEES } from "./mock-payees";
import { createMockAsk, mockAskReport } from "./mock-ask";
import type { MockTreeState } from "./mock-tree";
import type { TreeService } from "../tree/types";
import type { MockLettersState } from "./mock-letters";
import type { LettersService } from "../letters/types";
import type { AskNote } from "../ask/types";
import { sha256Hex } from "../agent/hash";
import { cleanSpec, mediaRootHex } from "../assets/spec";
import { DEMO_ASSETS } from "./demo-asset-photos";
import { fullName, shortName } from "../names";
import { waitingSecsFor } from "../will-summary";
import { DEMO_FX, estimateValuation } from "./mock-valuation";
import { checkInPlan, heartbeatFor } from "../checkin";
import type { BillDetails, BillPayee } from "../bills/types";
import { billActivityText, DEMO_BILL_PAYEES } from "../bills/book";
// Bill validation (zod) loads only when a bill is paid or a payee saved, not with the demo service on a first visit.
const billSchemas = () => import("../bills/payees");
import { demoInvoiceReading } from "../bills/demo";

export interface MockActor { address: Base58; role: Role; label: string }
/** "guardians": the estate unlocked, with a Guard set up before Thabo passed (seats, backups, Aunt Zodwa, fallback; 60/60/120 s). */
export const DEMO_STAGES = ["fresh", "funded", "unlocked", "listed", "lowOffers", "guardians"] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];

export interface MockService extends HeirloomService {
  mode: "mock";
  setActor(actor: MockActor | null): void;
  resetDemo(stage: DemoStage): void;
  balanceOf(address: Base58): bigint | null;
  /** Demo shortcuts (mock only): play the "passing reported and confirmed" steps, end the wait, or bring schedules due. */
  simulatePassing(): void;
  skipWait(): void;
  makeDue(): void;
  /**
   * Guardians demo shortcuts (mock only). Each plays steps the real people would do, or moves the demo clock;
   * they never skip a check that the contract makes.
   */
  /** Thabo sets up the demo guardians (backups, Aunt Zodwa as monitor, fallback order). Estate must be active. */
  setupDemoGuardians(): void;
  /** Uncle Bongani (or whoever holds the seat) approves a claim, so his monitors see it in their inbox. */
  simulateSeatApproval(index?: number): void;
  /** "Simulate Uncle Bongani's passing": Aunt Zodwa reports it, the agent clears the certificate, another trusted person confirms. */
  simulateSeatPassing(index?: number): void;
  /** Move the demo clock past the objection window (approvals), the succession wait or the fallback wait. */
  endObjectionWindow(): void;
  endSuccessionWait(): void;
  endFallbackWait(): void;
  /** "All trusted people are gone": every holder and backup recorded as passed, and Thabo's passing reported and cleared. */
  simulateAllSeatsVacant(): void;
  /** Check-in demo: move Thabo's last check-in back so `daysLeft` plan days remain (negative = overdue). Moves the clock only. */
  setCheckInDaysLeft(daysLeft: number): void;
}

export { isMockService } from "./is-mock";
import { MOCK_STORE_KEY } from "./is-mock";
import { MAX_RULES, MIN_LISTING_SECS, listingEnded, nextDueAfter, ruleEnded, surplusOf } from "../continuity/logic";
import { openToPeople, outcomeOf } from "../verdict";
import { MIN_WAIT_SECS, decidesAlone, isCurrentClaim, replaceableAt, reviewedHold, unlockWaitSecs } from "../death-rules";
import { claimTally, deathDisproved, deathTally, hardshipTally, hasLivingSeat, isHeld, mayList } from "../guardians/decisions";
import { clearDeath, proofOfLife } from "./mock-rules";
import { createMockContinuity, type MockAgentVotes } from "./mock-continuity";

/* ---------- demo cast ---------- */

type PersonaKey = "thabo" | "lerato" | "sipho" | "naledi" | "nomsa" | "david" | "busi" | "zanele" | "zodwa";

const CAST: { key: PersonaKey; name: string; relation: string }[] = [
  { key: "thabo", name: "Thabo Mokoena", relation: "Dad" },
  { key: "lerato", name: "Lerato Mokoena", relation: "Daughter, 20" },
  { key: "sipho", name: "Sipho Mokoena", relation: "Son, 18" },
  { key: "naledi", name: "Naledi Mokoena", relation: "Daughter, 15" },
  { key: "nomsa", name: "Adv. Thandi Ndlovu", relation: "Executor" },
  { key: "david", name: "Ms. Anita Pillay", relation: "Family attorney" },
  { key: "busi", name: "Uncle Bongani Mokoena", relation: "Thabo's brother" },
  { key: "zanele", name: "Pieter van Wyk", relation: "Car buyer" },
  { key: "zodwa", name: "Aunt Zodwa Mokoena", relation: "Thabo's sister, watches Bongani" },
];

/** Guardians demo cast that are not personas: Uncle Bongani's backups and the charity at the end of the fallback order. */
export const DEMO_GUARDIANS = {
  kagiso: { wallet: "8QDekGfekh5Bg85sbkoW5EQpxQmoqbL1SY3m3ieyW9BH", name: "Cousin Kagiso Mokoena" },
  priya: { wallet: "34biue8WinN94cpC41bcp6YkG5EUWicexxjd3zyjcnQ1", name: "Adv. Priya Naidoo" },
  charity: { wallet: "6gUaiCvYvtSfEY2y4ygyVSwTjnV4oNP5ENoCdweqPVsN", name: "Ithemba Children's Charity" },
} as const;

/** Same wallets, in the same order, as the wallet layer's mock personas (lib/wallet/personas.ts). */
export const DEMO_PERSONAS: { key: PersonaKey; label: string; role: Role; relation: string; address: Base58; usdt: number }[] =
  CAST.map((c, i) => ({ key: c.key, label: c.name, relation: c.relation, role: WALLET_PERSONAS[i].role, address: WALLET_PERSONAS[i].address, usdt: WALLET_PERSONAS[i].usdt }));

const AGENT = "AgNt1HeiRLooMwDKagentWaLLet7xQp5sZc3FdYg8uE6r";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const ESTATE = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const CAR_MINT = "CaRt1tLe2016ToYoTaCoRoLLa5sZc3FdYg8uE6rAoNFT1";
const BIKE_MINT = "BiKeT1tLe2025BiGBoYMuStAnG250sZc3FdYg8uE6rNFT";
/** The demo's digital titles for Thabo's car and motorbike (exported for tests). */
export const DEMO_MINTS = { car: CAR_MINT, bike: BIKE_MINT } as const;
/** Thabo's motorbike (the second demo asset): asking / minimum / hardship floor in USD₮ (Tumo, 15 Nov 2026). */
const BIKE_PRICES = { askingUsdt: 2000, floorUsdt: 1800, hardshipFloorUsdt: 1500 };
const RIVALS = [
  { address: "AyEsHaKhAn4xT8rLp3cZd6FgJy4bN7eQiBuYeR5551aa", name: "Ayesha Khan" },
  { address: "JoHaNbOtHa2xT5rLm8cZp3FgHy6bJ9eUaBuYeR662bcd", name: "Johan Botha" },
];
const PAYEES = DEMO_PAYEES;

export { DEMO_FX };
/** Demo clock: a 30 day waiting period lasts 60 seconds, and every schedule repeats every 60 seconds. */
export { DEMO_SECONDS_PER_DAY } from "../will-summary";
export const DEMO_INTERVAL_SECS = 60;

/* ---------- state ---------- */

interface State {
  v: 5;
  created: boolean;
  bind: Record<string, Base58>;
  snap: EstateSnapshot;
  balances: Record<Base58, bigint>;
  names: Record<Base58, string>;
  /** P2P sends: receipt plus what is needed to settle it once "the network" confirms. */
  sends: Record<string, { receipt: PaymentReceipt; from: Base58; to: Base58; toLabel: string; amount: bigint; confirmAt: number; bill?: BillDetails; ts?: number }>;
  /** Saved bill payees per wallet (added after v5 shipped; Thabo's demo payees appear on first use). */
  billPayees?: Record<Base58, BillPayee[]>;
  /** Guardians (added after v5 shipped; created on first use when a saved state has none). */
  guard?: MockGuardState;
  /** "Ask for money" notes by claim (added after v5 shipped; created on first use). */
  asks?: Record<Base58, AskNote>;
  /** Trust Tree: relationships the owner added or removed, hidden flags, photos (added after v5 shipped; created on first use). */
  tree?: MockTreeState;
  /** Letters for later (plan.md §16; added after v5 shipped; created on first use). */
  letters?: MockLettersState;
  /** Votes to replace the agent (second review; created on first use). */
  agentVotes?: MockAgentVotes;
  /** Assets taken back, title -> the address a fresh registration gets again (second review; created on first use). */
  released?: Record<Base58, Base58>;
  /** A plan being signed (H6): set before, cleared after. */
  signing?: { draft: WillDraft; options: import("../continuity/types").CreateEstateOptions };
  /** The assets the signed plan describes (M4). */
  planned?: WillDraft["assets"];
}

const SLOT_CLAIMS = 65_536;
const MAX_LISTING_SECS = 90 * 86_400;
const MAX_INTERVAL_SECS = 10 * 365 * 86_400;

const KEY = MOCK_STORE_KEY;
const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const rand = (n: number, alphabet: string) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const fakeSig = () => rand(88, B58);
const fakeAddr = () => rand(44, B58);
const fakeHash = () => rand(64, "0123456789abcdef");

function serialise(s: State): string {
  // blob: URLs (photos previewed in this tab) die with the page, so they are never saved.
  return JSON.stringify(s, (k, v) => (typeof v === "bigint" ? { $n: v.toString() } : k === "url" && typeof v === "string" && v.startsWith("blob:") ? "" : v));
}
function parse(raw: string): State {
  return JSON.parse(raw, (k, v) => (v && typeof v === "object" && typeof v.$n === "string" ? BigInt(v.$n) : k === "url" && typeof v === "string" && v.startsWith("blob:") ? "" : v));
}

function blank(): State {
  const bind: Record<string, Base58> = {};
  const balances: Record<Base58, bigint> = {};
  const names: Record<Base58, string> = { [AGENT]: "Heirloom agent" };
  for (const p of DEMO_PERSONAS) {
    bind[p.key] = p.address;
    names[p.address] = p.label;
    balances[p.address] = toBase(p.usdt);
  }
  RIVALS.forEach((r, i) => { names[r.address] = r.name; balances[r.address] = toBase(i === 0 ? 15000 : 13000); });
  PAYEES.forEach((p) => { names[p.wallet] = p.name; balances[p.wallet] = 0n; });
  DEMO_BILL_PAYEES.forEach((p) => { names[p.wallet] = p.name; balances[p.wallet] = 0n; });
  Object.values(DEMO_GUARDIANS).forEach((p) => { names[p.wallet] = p.name; balances[p.wallet] = 0n; });
  return {
    v: 5,
    guard: blankGuard(),
    sends: {},
    created: false,
    bind,
    balances,
    names,
    snap: {
      estate: {
        address: ESTATE, owner: bind.thabo, ownerName: "Thabo Mokoena", agent: AGENT, usdtMint: USDT_MINT,
        verifiers: [bind.nomsa, bind.david, bind.busi],
        verifierNames: ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"],
        deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60,
        status: "Active", willHash: null, vaultBalance: 0n,
        death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null },
        lastHeartbeat: 0,
      },
      beneficiaries: [], payees: [], rules: [], claims: [], assets: [], offers: [], hardships: [], activity: [],
    },
  };
}


const usd = (b: bigint) => `${fromBase(b).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} USD₮`;

/* ---------- the service ---------- */

/** The car's minimum price from the owner's words: the latest USD₮ amount wins ("change it to 13,000 USDT"), else a large rand amount. */
export function floorFromText(text: string, fallback = 12500): number {
  const found = amountsInText(text);
  const usdt = found.filter((a) => a.unit === "usd" && a.value !== null && a.value > 0).map((a) => a.value!);
  if (usdt.length) return usdt[usdt.length - 1];
  const zar = found.filter((a) => a.unit === "zar" && a.value !== null && a.value > 20000).map((a) => a.value!);
  return zar.length ? Math.round(zar[zar.length - 1] / DEMO_FX / 50) * 50 : fallback;
}

/**
 * A demo saved in this browser before the story car came with photos (15 Nov 2026): give Thabo's 2017 Corolla and
 * his motorbike their photos and spec sheets if they have none. Anything the owner changed is left alone.
 */
export function healDemoMedia(state: State): State {
  const guard = (state.guard ??= blankGuard());
  for (const a of state.snap.assets) {
    const d = a.nftMint === CAR_MINT && a.title === DEMO_ASSETS.corolla.title ? DEMO_ASSETS.corolla
      : a.nftMint === BIKE_MINT ? DEMO_ASSETS.mustang : null;
    if (!d || guard.media[a.address]) continue;
    guard.media[a.address] = { kind: d.kind, title: a.title, photos: structuredClone(d.photos), spec: structuredClone(d.spec), photosRoot: d.mediaRoot, updatedAt: Math.floor(Date.now() / 1000) };
  }
  return state;
}

/**
 * A demo saved in this browser by an older build: fills in what the second review's rules read (22 Nov 2026).
 * A report with no time counts as long stale, and approvals from before the death ask to be given again, as on-chain.
 */
export function healDemoState(state: State): State {
  const { snap } = state;
  if (!snap?.estate?.death || ![snap.beneficiaries, snap.payees, snap.rules, snap.claims, snap.assets, snap.offers, snap.hardships, snap.activity].every(Array.isArray)) {
    throw new Error("The saved demo can't be read.");
  }
  const d = snap.estate.death;
  d.attestations ??= [false, false, false];
  d.pendingSince ??= null;
  d.submittedAt ??= d.certHash && snap.estate.status === "Active" ? 0 : null;
  for (const b of snap.beneficiaries) b.active ??= true;
  for (const r of snap.rules) r.claimCount ??= snap.claims.reduce((n, c) => (c.rule === r.address ? Math.max(n, c.id + 1) : n), 0);
  state.guard = { ...blankGuard(), ...state.guard };
  return healDemoMedia(state);
}

/** Tests and simulations of what the demo can't show by itself. */
export interface MockOptions {
  /** Skips the simulated network latency. */
  instant?: boolean;
  /** How the scripted agent answers: "down" leaves a report unreviewed, "unsure" refers it to people. */
  agent?: () => "down" | "unsure" | null;
  /** Title mints that still have an authority (the demo's titles have none). */
  titleAuthorities?: Record<Base58, { mint?: boolean; freeze?: boolean }>;
}

/** `instant: true` skips the simulated network latency (tests). */
export function createMockService(opts: MockOptions = {}): MockService {
  let s: State = blank();
  let actor: MockActor | null = null;
  const wait = (ms: number) => (opts.instant ? Promise.resolve() : sleep(ms));

  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const loaded = parse(raw);
        if (loaded.v === 5) s = healDemoState(loaded);
      }
    } catch { /* storage blocked: stay in memory */ }
  }
  const save = () => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(KEY, serialise(s)); } catch { /* ignore */ }
  };

  const est = () => s.snap.estate;
  const name = (a: Base58) => s.names[a] ?? "Someone";
  const first = (a: Base58) => shortName(name(a)); // "Adv. Ndlovu", "Uncle Bongani", "Lerato"
  const me = (): Base58 => actor?.address ?? fail("NoWallet", "Choose who you are acting as first.");
  const tx = (): TxResult => { const signature = fakeSig(); return { signature, explorerUrl: explorerTx(signature) }; };
  const log = (kind: string, text: string, t: TxResult, amount?: bigint, payment?: PaymentRef) => {
    s.snap.activity.unshift({ ts: nowSecs(), kind, text, amount, txSignature: t.signature, ...(payment ? { payment } : {}) });
  };
  const need = (ok: boolean, code: string, detail: string) => { if (!ok) fail(code, detail); };
  const needCreated = () => need(s.created, "NoEstate", "There is no estate yet. The owner signs the will first.");
  const needOwner = () => need(me() === est().owner, "NotOwner", "Only the estate owner can do this.");
  const verifierIndex = () => {
    const i = isHeld(me()) ? est().verifiers.indexOf(me()) : -1;
    need(i >= 0, "NotVerifier", "Only one of the three trusted people can do this.");
    return i;
  };
  const needBeneficiary = () => need(s.snap.beneficiaries.some((b) => b.wallet === me() && b.active), "NotBeneficiary", "Only a named family member can do this.");
  const count = (a: boolean[]) => a.filter(Boolean).length;
  const unreviewed = () => opts.agent?.() === "down";
  const notInterested = (who: Base58 | null) => need(me() !== who, "OwnApproval", "You cannot approve in your own favour.");
  const isCurrent = (c: Claim, r: Rule | undefined) => !r || isCurrentClaim(c.id, r.claimCount ?? 0);
  /** Every payout: the beneficiary is still in the plan and the payee is still one the rule allows (R16). */
  const checkParties = (r: Rule, beneficiary: Base58, payee: Base58) => {
    need(s.snap.beneficiaries.some((b) => b.wallet === beneficiary && b.active), "NotBeneficiary", "This person is no longer in the plan.");
    const p = s.snap.payees.find((x) => x.wallet === payee) ?? fail("AccountNotInitialized", "This payee has been removed.");
    need(p.kind === r.allowedPayeeKind, "WrongPayeeKind", "This payee is no longer of the kind the rule allows.");
  };
  /** The named person, else the first living fallback recipient. */
  const residualNow = (): Base58 | null =>
    s.snap.residual ?? (s.guard?.enabled ? s.guard.fallback.find((_r, i) => !s.guard!.fallbackDead[i])?.wallet ?? null : null);
  const anyFamily = () => s.snap.beneficiaries.find((b) => b.wallet === s.bind.lerato && b.active) ?? s.snap.beneficiaries.find((b) => b.active);
  const credit = (a: Base58, amt: bigint) => { s.balances[a] = (s.balances[a] ?? 0n) + amt; };

  const G = createMockGuardians({
    guard: () => (s.guard ??= blankGuard()),
    snap: () => s.snap, names: () => s.names, created: () => s.created, me,
    dispute: (target) => D.latest(target),
    tx, log, credit, usd,
  });
  // Disputes (U9) and yearly caps: rules in mock-disputes.ts, hooked into the instructions below.
  const D = createMockDisputes({
    snap: () => s.snap, names: () => s.names, created: () => s.created, me, now: nowSecs, tx, log, usd,
    objections: () => s.guard?.objections ?? [],
    objectionOpen: (target) => G.objectionBinds(target),
  });
  // Replacing the agent, taking an asset back and removing people (second review): rules in mock-continuity.ts.
  const C = createMockContinuity({
    snap: () => s.snap, names: () => s.names, created: () => s.created, me, now: nowSecs, tx, log,
    votes: () => (s.agentVotes ??= {}), released: () => (s.released ??= {}), residual: residualNow,
    clearAgentReviews: () => G.clearAgentReviews(), isBackup: (w) => G.isBackup(w),
  });

  // "Ask for money": a living claim plus its off-chain note (mock-ask.ts).
  const A = createMockAsk({
    snap: () => s.snap, notes: () => (s.asks ??= {}), me, first, payeeName: (w) => s.snap.payees.find((p) => p.wallet === w)?.name ?? name(w),
    submit: (input, hash, r, reviewed) => submitClaim(input, hash, r, reviewed),
    hashFile: (f) => hashFile(f), suspicious: (f) => suspicious(f), fakeHash, unreviewed: () => unreviewed(), zar: (u) => zar(u), now: nowSecs, wait: async (ms) => { await wait(ms); }, save,
  });

  // Trust Tree: the Mokoena family story around this demo estate (mock-tree.ts), loaded on first use so the tree's
  // code stays out of every other page.
  let treeService: Promise<TreeService> | null = null;
  const Tr = () => (treeService ??= import("./mock-tree").then((m) => m.createMockTree({
    cast: {
      estate: ESTATE, thabo: s.bind.thabo, lerato: s.bind.lerato, sipho: s.bind.sipho, naledi: s.bind.naledi,
      ndlovu: s.bind.nomsa, pillay: s.bind.david, bongani: s.bind.busi, zodwa: s.bind.zodwa,
      kagiso: DEMO_GUARDIANS.kagiso.wallet, priya: DEMO_GUARDIANS.priya.wallet, charity: DEMO_GUARDIANS.charity.wallet,
    },
    snap: () => (s.created ? { ...s.snap, guardians: G.snapshot() } : null),
    tree: () => (s.tree ??= { added: [], removed: [], hidden: {} }),
    me, now: nowSecs, wait: async (ms) => { await wait(ms); }, save,
  })));

  // Letters for later (mock-letters.ts), loaded on first use like the tree.
  let lettersService: Promise<LettersService> | null = null;
  const Lt = () => (lettersService ??= import("./mock-letters").then((m) => m.createMockLetters({
    snap: () => (s.created ? s.snap : null), me, now: nowSecs, wait: async (ms) => { await wait(ms); }, save,
    state: () => (s.letters ??= { byId: {} }),
    sendConfirmed: (sig) => Object.values(s.sends).some((x) => x.receipt.signature === sig && x.receipt.status === "confirmed"),
    cast: { lerato: s.bind.lerato, naledi: s.bind.naledi }, usdtZar: DEMO_FX,
  })));

  /* ----- synchronous "instructions" (shared by the async API and the stage seeder) ----- */

  function createEstate(draft: WillDraft, residualLabel?: string, practice?: boolean): TxResult[] {
    need(!s.created, "BadStatus", "This estate already has a signed will.");
    const owner = me();
    const txs: TxResult[] = [];
    const e = est();
    const vKeys = ["nomsa", "david", "busi"];
    // Everything is checked before anything changes: signing is all or nothing (R14, U2).
    need(draft.verifiers.length === 3, "InvalidWallet", "Name three different trusted people.");
    const verifiers = draft.verifiers.map((v, i) => v.wallet ?? s.bind[vKeys[i]]);
    need(verifiers.every(isHeld), "InvalidWallet", "Each trusted person needs a real wallet.");
    need(!verifiers.includes(owner) && new Set(verifiers).size === 3, "DuplicateVerifier", "The three trusted people must be different, and not the owner.");
    need(isHeld(e.agent) && e.agent !== owner && !verifiers.includes(e.agent), "BadAgent", "The agent cannot be the owner or a trusted person.");
    need(draft.rules.length <= MAX_RULES, "TooManyRules", `A plan can have at most ${MAX_RULES} rules.`);
    for (const r of draft.rules) {
      need(r.maxPerClaimUsdt > 0 && r.maxPerClaimUsdt <= r.lifetimeCapUsdt, "InvalidAmount", "The per-claim limit must be above zero and within the total limit.");
      need(Math.floor(new Date(r.validUntil).getTime() / 1000) > nowSecs(), "TimeOutOfRange", "A rule's end date must be in the future.");
      if (!r.recurring) continue;
      need(r.recurring.amountUsdt <= r.maxPerClaimUsdt, "ExceedsPerClaimCap", "The scheduled payment is more than the rule's limit.");
      // Never downgraded to a rule paid on request: without practice payees the payee has to be an approved one.
      const known = PAYEES.some((p) => p.kind === r.allowedPayeeKind && p.name.toLowerCase() === r.recurring!.payeeName.trim().toLowerCase());
      need(known || (practice === true && !!r.recurring.payeeName.trim()), "recurring_payee", `"${r.recurring.payeeName}" is not an approved payee yet.`);
    }
    e.owner = owner;
    e.ownerName = draft.ownerName || actor?.label || "Estate owner";
    s.names[owner] = e.ownerName;
    e.verifiers = verifiers as [Base58, Base58, Base58];
    e.verifierNames = [0, 1, 2].map((i) => draft.verifiers[i]?.name ?? name(e.verifiers[i])) as [string, string, string];
    e.verifiers.forEach((v, i) => { s.names[v] = e.verifierNames[i]; });
    e.waitingPeriodSecs = Math.max(MIN_WAIT_SECS, waitingSecsFor(draft.waitingPeriodDays, "mock")); // the program reads at least 60 s
    e.status = "Active";
    e.lastHeartbeat = nowSecs();
    e.willHash = fakeHash();
    s.created = true;
    let t = tx(); txs.push(t);
    log("EstateCreated", `${first(owner)} created the estate and named three trusted people`, t);

    const kids = ["lerato", "sipho", "naledi"];
    draft.beneficiaries.forEach((b, i) => {
      const wallet = b.wallet ?? DEMO_PERSONAS.find((p) => p.label.toLowerCase().startsWith(b.label.toLowerCase().split(" ")[0]))?.key;
      const resolved = b.wallet ?? (wallet ? s.bind[wallet] : s.bind[kids[i]] ?? fakeAddr());
      s.names[resolved] = s.names[resolved] ?? b.label;
      s.snap.beneficiaries.push({ address: fakeAddr(), wallet: resolved, label: `${b.label.split(" ")[0]} (${b.relationship})`, active: true });
    });
    PAYEES.forEach((p) => s.snap.payees.push({ address: fakeAddr(), ...p }));
    const newPayee = (payeeName: string, kind: PayeeKind) => {
      const p = { address: fakeAddr(), wallet: fakeAddr(), kind, name: payeeName.trim().slice(0, 64) || "Payee" };
      s.snap.payees.push(p);
      s.names[p.wallet] = p.name;
      return p;
    };
    draft.rules.forEach((r, i) => {
      const ben = s.snap.beneficiaries.find((b) => b.label.toLowerCase().startsWith(r.beneficiaryLabel.toLowerCase().split(" ")[0])) ?? s.snap.beneficiaries[0];
      // A payee the demo doesn't know yet (a bill template's "Funeral cover insurer") gets a made-up wallet of its own.
      const fixed = r.recurring ? s.snap.payees.find((p) => p.kind === r.allowedPayeeKind && p.name.toLowerCase() === r.recurring!.payeeName.trim().toLowerCase()) ?? newPayee(r.recurring.payeeName, r.allowedPayeeKind) : undefined;
      s.snap.rules.push({
        address: fakeAddr(), id: i, beneficiary: ben.wallet, category: r.category, allowedPayeeKind: r.allowedPayeeKind,
        maxPerClaim: toBase(r.maxPerClaimUsdt), lifetimeCap: toBase(r.lifetimeCapUsdt), spentTotal: 0n,
        validUntil: Math.floor(new Date(r.validUntil).getTime() / 1000),
        startsNow: r.startsNow, claimCount: 0,
        recurringAmount: r.recurring && fixed ? toBase(r.recurring.amountUsdt) : 0n,
        intervalSecs: r.recurring && fixed ? DEMO_INTERVAL_SECS : 0,
        // The demo clock pays every 60 s; the signed plan still reads the interval the owner chose.
        ...(r.recurring && fixed ? { every: r.recurring.every } : {}),
        // Living schedules are due straight away; legacy schedules start when the estate unlocks.
        // As on-chain: a living schedule is first due one interval after signing.
        nextDue: r.recurring && fixed && r.startsNow ? nowSecs() + DEMO_INTERVAL_SECS : null,
        fixedPayee: r.recurring && fixed ? fixed.wallet : null,
      });
    });
    const heirAt = Math.max(0, draft.beneficiaries.findIndex((b) => b.label === residualLabel));
    s.snap.residual = s.snap.beneficiaries[heirAt]?.wallet ?? null;
    t = tx(); txs.push(t);
    log("WillSet", `Plan signed and locked: ${draft.rules.filter((r) => r.startsNow).length} rules start now, ${draft.rules.filter((r) => !r.startsNow).length} after a passing`, t);
    return txs;
  }

  /**
   * The demo story's own step after signing: Thabo adds Lerato's own wallet as an approved payee for her everyday needs
   * (as an owner would under People). Signing itself adds no payee the plan didn't name, as on-chain.
   */
  function addOwnWallets(draft: WillDraft) {
    // "Everyday needs" (General, paid to an "Other" payee): the child's own wallet is an approved payee too.
    for (const r of draft.rules.filter((x) => x.category === "General" && x.allowedPayeeKind === "Other")) {
      const ben = s.snap.beneficiaries.find((b) => b.label.toLowerCase().startsWith(r.beneficiaryLabel.toLowerCase().split(" ")[0]));
      if (ben && !s.snap.payees.some((p) => p.wallet === ben.wallet)) {
        s.snap.payees.push({ address: fakeAddr(), wallet: ben.wallet, kind: "Other", name: `${ben.label.split(" ")[0]}'s own wallet` });
        s.names[ben.wallet] = s.names[ben.wallet] ?? ben.label;
      }
    }
  }

  function addPayee(input: { wallet: Base58; kind: PayeeKind; name: string }): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "Institutions can only be added while the estate is active.");
    need(input.name.length <= 64, "StringTooLong", "That name is too long.");
    need(!s.snap.payees.some((p) => p.wallet === input.wallet), "BadStatus", "This wallet is already an approved payee.");
    s.snap.payees.push({ address: fakeAddr(), ...input });
    s.names[input.wallet] = input.name;
    const t = tx();
    log("PayeeAdded", `${input.name} added as an approved institution`, t);
    return t;
  }

  function addRule(input: Parameters<HeirloomService["addRule"]>[1]): TxResult {
    needCreated(); needOwner();
    const now = nowSecs();
    need(est().status === "Active", "BadStatus", "Rules cannot change once a passing is being confirmed.");
    need(s.snap.beneficiaries.some((b) => b.wallet === input.beneficiary && b.active), "NotBeneficiary", "A rule is for someone who is in the plan.");
    const slot = input.reuse ? s.snap.rules.find((r) => r.address === input.reuse) ?? fail("BadStatus", "That rule does not exist.") : null;
    // Only an ended rule gives up its slot: a live one's cap still matters (R17).
    if (slot) need(ruleEnded(slot, now), "BadStatus", "Only a rule that has ended can be replaced.");
    else need(s.snap.rules.length < MAX_RULES, "TooManyRules", `A plan can have at most ${MAX_RULES} rules.`);
    need(input.maxPerClaimUsdt > 0 && input.lifetimeCapUsdt > 0 && input.maxPerClaimUsdt <= input.lifetimeCapUsdt, "InvalidAmount", "The per-claim limit must be above zero and within the total limit.");
    need(input.validUntil > now, "TimeOutOfRange", "A rule's end date must be in the future.");
    const every = input.recurring;
    if (every) {
      need(every.amountUsdt > 0 && every.intervalSecs > 0, "InvalidAmount", "A schedule needs an amount and an interval.");
      need(every.intervalSecs <= MAX_INTERVAL_SECS && every.firstDue >= 0, "TimeOutOfRange", "That schedule is outside the allowed range.");
      need(every.amountUsdt <= input.maxPerClaimUsdt, "ExceedsPerClaimCap", "The scheduled payment is more than the rule's limit.");
      const p = s.snap.payees.find((x) => x.wallet === every.payee) ?? fail("PayeeRequired", "A schedule needs an approved payee.");
      need(p.kind === input.allowedPayeeKind, "WrongPayeeKind", "That payee is not of the kind this rule allows.");
    }
    const rule: Rule = {
      address: slot?.address ?? fakeAddr(), id: slot?.id ?? s.snap.rules.length,
      beneficiary: input.beneficiary, category: input.category, allowedPayeeKind: input.allowedPayeeKind,
      maxPerClaim: toBase(input.maxPerClaimUsdt), lifetimeCap: toBase(input.lifetimeCapUsdt), spentTotal: 0n, validUntil: input.validUntil,
      startsNow: input.startsNow,
      // A reused slot's claim ids start at the next multiple of 65,536, so an old claim never reads as this rule's.
      claimCount: slot ? (Math.floor((slot.claimCount ?? 0) / SLOT_CLAIMS) + 1) * SLOT_CLAIMS : 0,
      recurringAmount: every ? toBase(every.amountUsdt) : 0n,
      intervalSecs: every?.intervalSecs ?? 0,
      ...(every?.every ? { every: every.every } : {}),
      // A living schedule is first due when the owner said (firstDue), not straight away.
      nextDue: every && input.startsNow ? every.firstDue : null,
      fixedPayee: every?.payee ?? null,
    };
    const t = tx();
    if (slot) {
      // A fresh account in effect: nothing spent, and the ended rule's yearly cap is closed.
      s.snap.rules = s.snap.rules.map((r) => (r === slot ? rule : r));
      log("RuleReused", `An ended rule's place was used for a new ${input.category.toLowerCase()} rule for ${first(input.beneficiary)}`, t);
      s.snap.activity[0].reusedRule = rule.address;
    } else {
      s.snap.rules.push(rule);
      log("RuleAdded", `New ${input.category.toLowerCase()} rule added for ${first(input.beneficiary)}`, t);
    }
    return t;
  }

  /**
   * Letters for later (plan.md §16.5): Naledi's 500 USD₮ 18th-birthday gift, paid once to her own wallet on
   * 14 Aug 2029 (00:00 SAST). Her letter "For your 18th birthday" opens with it.
   */
  function addNalediGift() {
    const naledi = s.bind.naledi;
    if (!s.snap.payees.some((p) => p.wallet === naledi)) addPayee({ wallet: naledi, kind: "Other", name: "Naledi Mokoena" });
    addRule({
      beneficiary: naledi, category: "General", allowedPayeeKind: "Other", maxPerClaimUsdt: 500, lifetimeCapUsdt: 500,
      validUntil: Date.UTC(2030, 11, 31, 22) / 1000, startsNow: true,
      recurring: { amountUsdt: 500, intervalSecs: 365 * 86_400, firstDue: Date.UTC(2029, 7, 13, 22) / 1000, payee: naledi },
    });
  }

  function deposit(amountUsdt: number): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "Deposits are only possible while the estate is active.");
    const amt = toBase(amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    need((s.balances[me()] ?? 0n) >= amt, "InsufficientFunds", "Your wallet does not hold that much USD₮.");
    s.balances[me()] -= amt;
    est().vaultBalance += amt;
    const t = tx();
    log("Deposit", `${first(me())} added ${usd(amt)} to the vault`, t, amt);
    return t;
  }

  function withdraw(amountUsdt: number): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "The vault is locked to its rules once a passing is being confirmed.");
    const amt = toBase(amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    need(est().vaultBalance >= amt, "InsufficientFunds", "The vault does not hold that much.");
    est().vaultBalance -= amt;
    credit(me(), amt);
    const t = tx();
    log("Withdraw", `${first(me())} withdrew ${usd(amt)} from the vault`, t, amt);
    return t;
  }

  function registerAsset(input: { nftMint: Base58; title: string; floorUsdt: number; hardshipFloorUsdt: number; askingUsdt: number; proceedsTo: Base58 }, docHash: string): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "Assets can only be added while the estate is active.");
    // Any number of assets (car, furniture, ...), one per digital title; a missing mint gets a demo one.
    const mint = input.nftMint || (s.snap.assets.length ? fakeAddr() : CAR_MINT);
    need(!s.snap.assets.some((a) => a.nftMint === mint), "BadStatus", "This asset is already registered.");
    need(input.hardshipFloorUsdt > 0 && input.floorUsdt >= input.hardshipFloorUsdt, "InvalidAmount", "The hardship floor must be above zero and no higher than the minimum price.");
    need(input.askingUsdt >= input.floorUsdt, "InvalidAmount", "The asking price cannot be below the minimum price.");
    const held = opts.titleAuthorities?.[mint];
    need(!held?.mint && !held?.freeze, "InvalidNft", "Nobody may be able to mint another title or freeze it.");
    // The estate itself is a real destination: the sale then pays into the vault (the default).
    need(!input.proceedsTo || isHeld(input.proceedsTo), "InvalidWallet", "The sale's money needs a real wallet, or the vault.");
    const asset: Asset = {
      address: s.released?.[mint] ?? fakeAddr(), nftMint: mint, title: input.title, imageUrl: s.snap.assets.length === 0 ? "/car-corolla.svg" : undefined,
      floorPrice: toBase(input.floorUsdt), hardshipFloor: toBase(input.hardshipFloorUsdt), askingPrice: toBase(input.askingUsdt),
      proceedsTo: input.proceedsTo || ESTATE, status: "Held", listingEnds: null, docHash, hardshipBeneficiary: null,
    };
    s.snap.assets.push(asset);
    const t = tx();
    log("AssetRegistered", `${asset.title} added. Its digital title is now held by the estate`, t);
    // Demo: Thabo's story Corolla comes with its 16 labelled photos and spec sheet, and his motorbike joins it,
    // however the story reached this point (guided story, chat or a stage shortcut). The owner can change both.
    if (mint === CAR_MINT && /corolla/i.test(asset.title)) {
      addDemoMedia(asset, DEMO_ASSETS.corolla);
      if (!s.snap.assets.some((a) => a.nftMint === BIKE_MINT)) {
        const bike: Asset = {
          address: s.released?.[BIKE_MINT] ?? fakeAddr(), nftMint: BIKE_MINT, title: DEMO_ASSETS.mustang.title,
          floorPrice: toBase(BIKE_PRICES.floorUsdt), hardshipFloor: toBase(BIKE_PRICES.hardshipFloorUsdt), askingPrice: toBase(BIKE_PRICES.askingUsdt),
          proceedsTo: input.proceedsTo || ESTATE, status: "Held", listingEnds: null, docHash: fakeHash(), hardshipBeneficiary: null,
        };
        s.snap.assets.push(bike);
        log("AssetRegistered", `${bike.title} added. Its digital title is now held by the estate`, tx());
        addDemoMedia(bike, DEMO_ASSETS.mustang);
      }
    }
    return t;
  }

  /** Records a demo asset's photos and spec sheet (its media root was computed when the photos were converted). */
  function addDemoMedia(a: Asset, d: (typeof DEMO_ASSETS)[keyof typeof DEMO_ASSETS]) {
    G.setAssetMedia(a.address, { kind: d.kind, title: a.title, photos: d.photos, spec: d.spec }, d.mediaRoot);
  }

  function endRule(address: Base58): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "Rules cannot change once a passing is being confirmed.");
    const r = s.snap.rules.find((x) => x.address === address) ?? fail("BadStatus", "That rule does not exist.");
    need(nowSecs() <= r.validUntil, "RuleExpired", "This rule has already ended.");
    r.validUntil = nowSecs() - 1;
    const t = tx();
    log("RuleEnded", `${first(me())} ended a ${r.category.toLowerCase()} rule. It cannot pay any more`, t);
    return t;
  }

  function setResidual(recipient: Base58): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active", "BadStatus", "This can only change while the estate is active.");
    need(isHeld(recipient) && recipient !== est().owner && recipient !== est().address, "NoResidualRecipient", "Choose someone other than the owner.");
    s.snap.residual = recipient;
    const t = tx();
    log("ResidualSet", `${first(recipient)} will receive whatever no rule needs`, t);
    return t;
  }

  function sweepResidual(): TxResult {
    needCreated();
    const e = est();
    need(e.status === "Unlocked", "BadStatus", "Only after the estate has unlocked.");
    const to = s.snap.residual ?? G.sweepRecipient() ?? fail("NoResidualRecipient", "Nobody was named to receive what is left.");
    const amount = surplusOf(e.vaultBalance, s.snap.rules, nowSecs());
    need(amount > 0n, "NothingToSweep", "The rules still need everything in the vault.");
    e.vaultBalance -= amount;
    credit(to, amount);
    const t = tx();
    log("ResidualSwept", `${usd(amount)} that no rule needed was paid to ${first(to)}`, t, amount, { payee: to });
    return t;
  }

  /** An active beneficiary, a living trusted person or a living listed fallback recipient reports the owner's death; never the agent. */
  function checkDeathSubmission() {
    needCreated();
    const e = est();
    const who = me();
    need(who !== e.agent, "NotParticipant", "The agent never reports the owner's passing.");
    need(s.snap.beneficiaries.some((b) => b.wallet === who && b.active) || (isHeld(who) && e.verifiers.includes(who)) || G.livingListed(who),
      "NotBeneficiary", "Only the family in this plan, a trusted person or someone on the fallback list can report the owner's passing.");
    // A disproved claim (the owner showed life after it) is replaced at once, also while DeathPending.
    if (deathDisproved(e)) return;
    need(e.status === "Active", "BadStatus", "A passing has already been reported for this estate.");
    const d = e.death;
    if (!d.certHash) return;
    // One open claim at a time. An unreviewed one is never replaced (it waits for the agent's review); a reviewed one
    // once stale. With nobody left a reviewed one is the fallback plan's proof (R5).
    need(d.verdict !== "Pending", "BadStatus", "A passing has already been reported and the agent hasn't reviewed it yet, so it can't be replaced until it has.");
    need(
      hasLivingSeat(e) && nowSecs() >= replaceableAt({
        verdict: d.verdict, reportedAt: d.submittedAt ?? 0, reporter: d.submittedBy, who: me(),
        waitingSecs: e.waitingPeriodSecs, hold: reviewedHold(e.waitingPeriodSecs), death: true,
      }),
      "BadStatus", "A passing has already been reported, and it is too soon to replace that report.",
    );
  }

  /** submit_death_claim + review_death in one step (null: the agent hasn't read it yet). */
  function submitDeath(certHash: string, r: AgentReport | null): TxResult {
    checkDeathSubmission();
    const e = est();
    const t = tx();
    log("DeathClaimSubmitted", `${first(me())} reported that ${first(e.owner)} has passed away`, t);
    clearDeath(e);
    e.status = "Active"; // a disproved claim replaced while DeathPending
    const outcome = r ? outcomeOf(r.verdict) : null;
    if (outcome === "Reject") {
      log("DeathReviewed", "The agent could not accept the certificate. Nothing has changed", tx());
      return t;
    }
    const d = e.death;
    d.certHash = certHash; d.submittedBy = me(); d.submittedAt = nowSecs();
    if (!r) return t;
    d.agentReport = r;
    d.verdict = outcome === "Refer" ? "Referred" : "Approved";
    if (outcome === "Refer") log("ReviewReferred", "The agent was not sure about the certificate, so the trusted people decide", tx());
    else log("DeathReviewed", "The agent read the death certificate and found no problems", tx());
    return t;
  }

  function attestDeath(): TxResult {
    needCreated();
    const i = verifierIndex();
    const e = est();
    const d = e.death;
    need(!!d.certHash, "NoDeathClaim", "No passing has been reported.");
    need(e.status === "Active" || e.status === "DeathPending", "BadStatus", "The estate has already unlocked.");
    need(openToPeople(d.verdict), "AgentNotApproved", "The agent has not cleared the certificate.");
    need(!deathDisproved(e), "DeathDisproved", "The owner showed they are alive after this passing was reported.");
    // Whoever reported it confirms only as the only trusted person left, and only when the agent approved.
    const alone = me() === d.submittedBy;
    need(!alone || decidesAlone(e.verifiers, me(), d.verdict), "OwnApproval", "You cannot approve in your own favour.");
    const firstTime = !d.attestations[i];
    const votes = d.attestations.map((v, j) => v || j === i);
    const q = deathTally({ ...e, death: { ...d, attestations: votes } });
    const starts = e.status === "Active" && q.met;
    // Signing again only completes a quorum that has dropped since (R8).
    need(firstTime || starts, "AlreadyApproved", "You have already confirmed this.");
    d.attestations = votes;
    const t = tx();
    log("DeathAttested", `${first(me())} confirmed the passing (${q.got} of ${q.needed})`, t);
    if (starts) {
      e.status = "DeathPending";
      d.pendingSince = nowSecs();
      // Decided alone: the unlock waits twice the waiting period.
      if (alone) d.decidedAlone = true;
    }
    G.recordApproval({
      kind: "Unlock", seatIndex: i, target: e.address, t, summary: `Confirmed ${first(e.owner)}'s passing`,
      deadline: e.status === "DeathPending" && d.pendingSince !== null ? d.pendingSince + unlockWaitSecs(e) : null,
    });
    return t;
  }

  function vetoDeath(): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active" || est().status === "DeathPending", "BadStatus", "The estate has already unlocked.");
    const e = est();
    e.status = "Active";
    clearDeath(e);
    e.lastHeartbeat = nowSecs();
    const t = tx();
    log("DeathVetoed", `${first(e.owner)} said "I'm still here". The report was cancelled and the vault stays locked`, t);
    return t;
  }

  function heartbeat(): TxResult {
    needCreated(); needOwner();
    need(est().status === "Active" || est().status === "DeathPending", "BadStatus", "The estate has already unlocked.");
    const t = tx();
    log("Heartbeat", `${first(me())} checked in: "I'm still here"`, t);
    proofOfLife(est(), nowSecs(), log, tx);
    return t;
  }

  /** Legacy schedules start when the estate unlocks. */
  function startSchedules() {
    for (const r of s.snap.rules) if (r.recurringAmount > 0n && r.nextDue === null) r.nextDue = nowSecs();
  }

  function finalizeUnlock(force = false): TxResult {
    needCreated();
    const e = est();
    need(e.status === "DeathPending", "BadStatus", "The estate is not waiting to unlock.");
    need(force || !deathDisproved(e), "DeathDisproved", "The owner showed they are alive after this passing was reported.");
    need(force || nowSecs() >= (e.death.pendingSince ?? 0) + unlockWaitSecs(e), "WaitingPeriodNotOver", "The waiting period has not ended yet.");
    G.checkNotObjected(e.address);
    D.checkNotDisputed(e.address);
    e.status = "Unlocked";
    startSchedules();
    const t = tx();
    log("EstateUnlocked", "Waiting period over. The estate is unlocked and the rules are now in force", t);
    return t;
  }

  function submitClaim(input: { rule: Base58; payee: Base58; amountUsdt: number }, evidenceHash: string, report: AgentReport | null, reviewed?: string): { t: TxResult; claim: Claim } {
    needCreated(); needBeneficiary();
    const rule = s.snap.rules.find((r) => r.address === input.rule) ?? fail("BadStatus", "That rule does not exist.");
    need(est().status === "Unlocked" || (rule.startsNow && est().status === "Active"), "BadStatus", rule.startsNow ? "Claims are paused while a passing is being confirmed." : "This rule only starts after the estate is unlocked.");
    need(rule.beneficiary === me(), "NotBeneficiary", "This rule was written for someone else.");
    const payee = s.snap.payees.find((p) => p.wallet === input.payee) ?? fail("WrongPayeeKind", "That institution is not on the approved list.");
    need(payee.kind === rule.allowedPayeeKind, "WrongPayeeKind", `This rule only pays a ${rule.allowedPayeeKind.toLowerCase()}.`);
    const amt = toBase(input.amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    need(amt <= rule.maxPerClaim, "ExceedsPerClaimCap", `The most this rule pays per claim is ${usd(rule.maxPerClaim)}.`);
    need(rule.spentTotal + amt <= rule.lifetimeCap, "ExceedsLifetimeCap", `Only ${usd(rule.lifetimeCap - rule.spentTotal)} is left under this rule.`);
    need(nowSecs() <= rule.validUntil, "RuleExpired", "This rule has ended.");
    D.checkYearly(rule, amt, false);
    const id = rule.claimCount ?? 0;
    need(isCurrentClaim(id, id + 1), "MathOverflow", "This rule can't take any more claims.");
    const claim: Claim = {
      address: fakeAddr(), rule: rule.address, id, beneficiary: me(), payee: payee.wallet, amount: amt,
      evidenceHash, agentVerdict: "Pending", approvals: [false, false, false], ownerApproved: false, status: "Open", createdAt: nowSecs(),
    };
    s.snap.claims.unshift(claim);
    rule.claimCount = id + 1;
    const t = tx();
    log("ClaimSubmitted", `${first(me())} asked for ${usd(amt)} to be paid to ${payee.name}`, t, amt);
    // No report: the agent's review didn't finish, and the claim waits for it (H7).
    if (report) reviewClaim(claim, report, reviewed);
    return { t, claim };
  }

  /** review_claim: as on-chain (/api/review), only "reject" blocks; an unsure agent refers, it never approves. */
  function reviewClaim(claim: Claim, report: AgentReport, reviewed?: string) {
    const rule = s.snap.rules.find((r) => r.address === claim.rule);
    const outcome = outcomeOf(report.verdict);
    claim.agentVerdict = outcome === "Approve" ? "Approved" : outcome === "Refer" ? "Referred" : "Rejected";
    claim.agentReport = report;
    if (outcome === "Reject") claim.status = "Rejected";
    log("ClaimReviewed", reviewed ?? (outcome === "Refer" ? "The agent was not sure, so it referred the claim to people" : outcome !== "Reject" ? `The agent checked the ${rule?.category.toLowerCase() ?? "claim's"} statement: it matches the claim` : "The agent could not accept the document. The claim was declined"), tx());
  }

  function approveClaim(address: Base58): TxResult {
    needCreated();
    const i = verifierIndex();
    const c = s.snap.claims.find((x) => x.address === address) ?? fail("BadStatus", "That claim does not exist.");
    const e = est();
    // While the owner is alive only the owner approves; the trusted people decide after the unlock (R3).
    need(e.status === "Unlocked", "BadStatus", "Trusted people approve claims only after the estate unlocks.");
    need(c.status === "Open", "BadStatus", "This claim is already closed.");
    need(openToPeople(c.agentVerdict), "AgentNotApproved", "The agent has not cleared this claim.");
    // The claimant approves only as the only trusted person left, and only when the agent approved.
    const alone = me() === c.beneficiary;
    need(!alone || decidesAlone(e.verifiers, me(), c.agentVerdict), "OwnApproval", "You cannot approve in your own favour.");
    need(!s.asks?.[c.address]?.declinedAt, "Declined", "The owner said no to this request while alive.");
    // Approvals from before this death neither pay nor stand in the way of a fresh quorum.
    const counts = G.countsFor(c);
    const given = counts ? c.approvals : [false, false, false];
    const reached = counts && !!s.guard?.stamps[c.address]?.approvedAt;
    const wasMet = claimTally(e, { ...c, approvals: given }).met;
    const firstTime = !given[i];
    const votes = given.map((v, j) => v || j === i);
    const starts = claimTally(e, { ...c, approvals: votes }).met && (!reached || !wasMet);
    need(firstTime || starts, "AlreadyApproved", "You have already approved this.");
    if (!counts) delete s.guard?.stamps[c.address];
    c.approvals = votes;
    // Decided alone: twice the objection window (DECIDED_ALONE). It goes with approvals that no longer count.
    c.decidedAlone = (counts && !!c.decidedAlone) || alone;
    const t = tx();
    log("ClaimApproved", `${first(me())} approved ${first(c.beneficiary)}'s claim`, t);
    const deadline = G.recordStamp(c, i, starts);
    G.recordApproval({ kind: "Claim", seatIndex: i, target: c.address, t, deadline, summary: `Approved ${usd(c.amount)} to ${name(c.payee)} for ${first(c.beneficiary)}` });
    return t;
  }

  function ownerApproveClaim(address: Base58): TxResult {
    needCreated(); needOwner();
    const c = s.snap.claims.find((x) => x.address === address) ?? fail("BadStatus", "That claim does not exist.");
    const rule = s.snap.rules.find((r) => r.address === c.rule)!;
    need(rule.startsNow, "BadStatus", "Only living-plan rules can be approved by the owner.");
    need(est().status === "Active", "BadStatus", "Owner approval only applies while the estate is active.");
    need(c.status === "Open", "BadStatus", "This claim cannot be approved.");
    need(openToPeople(c.agentVerdict), "AgentNotApproved", "The agent has not cleared this claim.");
    need(isCurrent(c, rule), "ClaimFromEndedRule", "This claim belongs to a rule that was ended and replaced.");
    need(!c.ownerApproved, "AlreadyApproved", "You have already approved this.");
    c.ownerApproved = true;
    const t = tx();
    log("ClaimApproved", `${first(me())} approved ${first(c.beneficiary)}'s claim under the living plan`, t);
    return t;
  }

  function executeScheduled(address: Base58, force = false, shown?: { amount: bigint; payee: Base58 }): TxResult {
    needCreated();
    const r = s.snap.rules.find((x) => x.address === address) ?? fail("BadStatus", "That rule does not exist.");
    need(!shown || (r.fixedPayee === shown.payee && r.recurringAmount === shown.amount), "ScheduleChanged", "This schedule changed since you looked. Nothing was paid.");
    need(r.recurringAmount > 0n && !!r.fixedPayee, "BadStatus", "This rule has no schedule.");
    const st = est().status;
    need(st === "Unlocked" || (r.startsNow && st === "Active"), "BadStatus", r.startsNow ? "Scheduled payments pause while a passing is being confirmed." : "This schedule starts after the estate is unlocked.");
    checkParties(r, r.beneficiary, r.fixedPayee!);
    need(force || (r.nextDue !== null && nowSecs() >= r.nextDue), "NotDue", "This payment is not due yet.");
    need(nowSecs() <= r.validUntil, "RuleExpired", "This rule has ended.");
    need(r.spentTotal + r.recurringAmount <= r.lifetimeCap, "ExceedsLifetimeCap", `Only ${usd(r.lifetimeCap - r.spentTotal)} is left under this rule.`);
    need(est().vaultBalance >= r.recurringAmount, "InsufficientFunds", "The vault does not hold enough for this payment.");
    D.checkYearly(r, r.recurringAmount, true);
    est().vaultBalance -= r.recurringAmount;
    r.spentTotal += r.recurringAmount;
    credit(r.fixedPayee!, r.recurringAmount);
    // As on-chain: one instalment, then the next date on the schedule after now (a forced demo payment restarts from now).
    r.nextDue = r.nextDue !== null && !force ? nextDueAfter(r.nextDue, r.intervalSecs, nowSecs()) : nowSecs() + r.intervalSecs;
    const t = tx();
    log("ScheduledPaid", `Scheduled payment: ${usd(r.recurringAmount)} paid to ${name(r.fixedPayee!)} for ${first(r.beneficiary)}`, t, r.recurringAmount, { payee: r.fixedPayee!, rule: r.address });
    return t;
  }

  function executeClaim(address: Base58): TxResult {
    needCreated();
    const c = s.snap.claims.find((x) => x.address === address) ?? fail("BadStatus", "That claim does not exist.");
    const rule = s.snap.rules.find((r) => r.address === c.rule)!;
    need(est().status === "Unlocked" || (rule.startsNow && est().status === "Active"), "BadStatus", "This claim cannot be paid right now.");
    need(c.status === "Open", "BadStatus", "This claim cannot be paid.");
    need(isCurrent(c, rule), "ClaimFromEndedRule", "This claim belongs to a rule that was ended and replaced.");
    checkParties(rule, c.beneficiary, c.payee);
    need(openToPeople(c.agentVerdict), "AgentNotApproved", "The agent has not cleared this claim.");
    need(c.ownerApproved || !s.asks?.[c.address]?.declinedAt, "Declined", "The owner said no to this request while alive.");
    // As on-chain: while the owner is alive only his approval counts; after unlock his approval, or a quorum given after the death.
    const approvedToPay = c.ownerApproved || (est().status === "Unlocked" && G.countsFor(c) && claimTally(est(), { ...c, approvalsCount: true }).met);
    need(approvedToPay, "InsufficientApprovals", est().status === "Active" ? "The owner still needs to approve this." : "A trusted person still needs to approve this.");
    G.checkClaimExecutable(c.address, !c.ownerApproved);
    D.checkNotDisputed(c.address);
    need(rule.spentTotal + c.amount <= rule.lifetimeCap, "ExceedsLifetimeCap", "This would go over the rule's total limit.");
    need(nowSecs() <= rule.validUntil, "RuleExpired", "This rule has ended.");
    need(est().vaultBalance >= c.amount, "InsufficientFunds", "The vault does not hold enough for this payment.");
    D.checkYearly(rule, c.amount, true);
    est().vaultBalance -= c.amount;
    rule.spentTotal += c.amount;
    credit(c.payee, c.amount);
    c.status = "Paid";
    const t = tx();
    c.txSignature = t.signature;
    log("ClaimPaid", `${usd(c.amount)} paid straight to ${name(c.payee)} for ${first(c.beneficiary)}`, t, c.amount, { payee: c.payee, rule: c.rule, claim: c.address });
    return t;
  }

  function listAsset(address: Base58, durationSecs: number, withRivals: "both" | "low" | "none" = "both"): TxResult {
    needCreated();
    const a = s.snap.assets.find((x) => x.address === address) ?? fail("BadStatus", "That asset does not exist.");
    need(me() === est().agent || mayList(s.snap, a, me(), nowSecs()), "NotVerifier",
      "Only a trusted person can open the sale. Family can, when no trusted person is left, for an asset not yet listed or a listing that ended without an acceptable offer.");
    need(est().status === "Unlocked", "BadStatus", "The car can only be sold after the estate unlocks.");
    need(a.status === "Held" || listingEnded(a, nowSecs()), "BadStatus", "This car is already listed or sold.");
    need(durationSecs >= MIN_LISTING_SECS && durationSecs <= MAX_LISTING_SECS, "TimeOutOfRange", "A listing lasts from an hour to 90 days.");
    const relisted = a.status === "Listed";
    a.status = "Listed";
    a.listingEnds = nowSecs() + durationSecs;
    const t = tx();
    log("AssetListed", `${a.title} listed for sale at ${usd(a.askingPrice)}`, t, a.askingPrice);
    const add = (r: (typeof RIVALS)[number], amountUsdt: number) => {
      const amt = toBase(amountUsdt);
      s.balances[r.address] = (s.balances[r.address] ?? 0n) - amt;
      s.snap.offers.push({ address: fakeAddr(), asset: a.address, buyer: r.address, buyerName: r.name, amount: amt, createdAt: nowSecs() });
      log("OfferPlaced", `${r.name} put ${usd(amt)} in escrow as an offer`, tx(), amt);
    };
    const floor = fromBase(a.floorPrice);
    if (!relisted && withRivals !== "none") add(RIVALS[1], Math.round(floor * 0.93 / 50) * 50);
    if (!relisted && withRivals === "both") add(RIVALS[0], Math.round(floor * 1.017 / 50) * 50);
    return t;
  }

  function placeOffer(assetAddr: Base58, amountUsdt: number, buyerName?: string): TxResult {
    needCreated();
    const a = s.snap.assets.find((x) => x.address === assetAddr) ?? fail("BadStatus", "That listing does not exist.");
    need(a.status === "Listed", "ListingClosed", "This listing is not open for offers.");
    need(a.listingEnds === null || nowSecs() < a.listingEnds, "ListingClosed", "This listing has ended.");
    const amt = toBase(amountUsdt);
    need(amt > 0n, "InvalidAmount", "Enter an amount above zero.");
    const existing = s.snap.offers.find((o) => o.asset === a.address && o.buyer === me());
    const available = (s.balances[me()] ?? 0n) + (existing?.amount ?? 0n);
    need(available >= amt, "InsufficientFunds", "Your wallet does not hold that much USD₮.");
    if (existing) s.snap.offers = s.snap.offers.filter((o) => o !== existing);
    s.balances[me()] = available - amt;
    // The name the buyer gave with the offer, unless the estate already names this wallet.
    s.names[me()] = s.names[me()] ?? (buyerName?.trim().slice(0, 64) || actor?.label || "Buyer");
    s.snap.offers.push({ address: fakeAddr(), asset: a.address, buyer: me(), buyerName: name(me()), amount: amt, createdAt: nowSecs() });
    const t = tx();
    log("OfferPlaced", `${name(me())} put ${usd(amt)} in escrow as an offer`, t, amt);
    return t;
  }

  function withdrawOffer(assetAddr: Base58): TxResult {
    needCreated();
    const o = s.snap.offers.find((x) => x.asset === assetAddr && x.buyer === me()) ?? fail("BadStatus", "You have no offer on this listing.");
    s.snap.offers = s.snap.offers.filter((x) => x !== o);
    credit(me(), o.amount);
    const t = tx();
    log("OfferWithdrawn", `${name(me())} took back an offer of ${usd(o.amount)}`, t, o.amount);
    return t;
  }

  function rank(assetAddr: Base58): { a: Asset; ranking: OfferRanking; min: bigint; hardship: boolean } {
    const a = s.snap.assets.find((x) => x.address === assetAddr) ?? fail("BadStatus", "That listing does not exist.");
    const hardship = !!a.hardshipBeneficiary;
    const min = hardship ? a.hardshipFloor : a.floorPrice;
    const all = s.snap.offers.filter((o) => o.asset === a.address).sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : x.createdAt - y.createdAt));
    // As the chain's ranking (lib/agent/offers.ts): an offer nobody could co-sign never ranks, so it can't block the others.
    const held = est().verifiers.filter(isHeld);
    const unsignable = (buyer: Base58) => buyer === est().agent || (held.length > 0 && held.every((v) => v === buyer || v === est().agent));
    // As accept_offer against the clock (lib/agent/offers.ts): an offer from before an upheld objection to the sale is
    // never accepted; with guardians an offer, and a hardship's approval, wait out the objection window.
    const timing = G.saleTiming(a);
    const tooOld = (o: Offer) => timing.saleObjectionUpheldAt !== null && o.createdAt <= timing.saleObjectionUpheldAt;
    const window = timing.objectionWindowSecs;
    const hardshipUntil = window !== null && hardship && timing.hardshipQuorumAt ? timing.hardshipQuorumAt + window : 0;
    const readyAt = (o: Offer) => { const at = Math.max(hardshipUntil, window !== null ? o.createdAt + window : 0); return at > timing.now ? at : null; };
    const offers = all.filter((o) => !unsignable(o.buyer));
    const eligible = offers.filter((o) => o.amount >= min && !tooOld(o) && !readyAt(o)).map((o, i) => ({
      offer: o.address, amount: o.amount,
      reason: i === 0 ? (hardship ? "Highest offer at or above the hardship floor" : "Highest offer at or above the minimum price") : "Meets the minimum, but a higher offer exists",
    }));
    const ineligible: OfferRanking["ineligible"] = offers.filter((o) => o.amount < min && !tooOld(o)).map((o) => ({
      offer: o.address, amount: o.amount,
      reason: hardship ? `Below the hardship floor of ${usd(a.hardshipFloor)}. The contract will never accept this` : `Below the minimum price of ${usd(a.floorPrice)}. Blocked unless a hardship request is approved`,
    }));
    for (const o of offers.filter(tooOld)) {
      ineligible.push({ offer: o.address, amount: o.amount, reason: "Made before an objection to the sale was upheld, so it can't be accepted. The buyer has to make a new offer" });
    }
    for (const o of offers.filter((x) => x.amount >= min && !tooOld(x) && readyAt(x))) {
      ineligible.push({ offer: o.address, amount: o.amount, readyAt: readyAt(o)!, reason: hardshipUntil > timing.now
        ? "Monitors can still object to the hardship approval. The sale can be signed after that"
        : "Monitors can still object to this offer. It can be accepted after that" });
    }
    const blocked = all.filter((o) => unsignable(o.buyer)).map((o) => ({
      offer: o.address, amount: o.amount,
      reason: o.buyer === est().agent ? "The agent can't buy from a plan it serves." : "No trusted person other than the buyer is left to co-sign this sale.",
    }));
    return { a, ranking: { bestOffer: eligible[0]?.offer ?? null, eligible, ineligible: [...ineligible, ...blocked] }, min, hardship };
  }

  /** accept_offer(expected_amount): the agent signs and pays, the trusted person co-signs (R12, R19). */
  function acceptBest(assetAddr: Base58, seen?: { offer: Base58; amount: bigint; recipient: Base58 } | null): { t: TxResult; ranking: OfferRanking } {
    needCreated();
    const { a, ranking, hardship } = rank(assetAddr);
    const e = est();
    need(a.status === "Listed", "BadStatus", "This car is not listed for sale.");
    need(seen !== null || !ranking.bestOffer, "OfferChanged", "An offer arrived after you looked. Check it before you sign.");
    if (seen) {
      const now = s.snap.offers.find((x) => x.address === ranking.bestOffer);
      need(now?.address === seen.offer && now.amount === seen.amount && (a.hardshipBeneficiary ?? a.proceedsTo) === seen.recipient, "OfferChanged",
        "The offer or who gets the money changed after you read it. Check the new one before you sign.");
    }
    G.checkNotObjected(a.address);
    if (hardship) for (const h of s.snap.hardships.filter((x) => x.asset === a.address && x.status === "Approved")) G.checkNotObjected(h.address);
    need(ranking.eligible.length + ranking.ineligible.length > 0, "InvalidAmount", "There are no offers yet.");
    const o = s.snap.offers.find((x) => x.address === ranking.bestOffer);
    need(o?.buyer !== e.agent, "BadAgent", "The agent cannot be the buyer.");
    const signer = me();
    if (hasLivingSeat(e)) {
      need(isHeld(signer) && signer !== o?.buyer && signer !== e.agent && e.verifiers.includes(signer), "CoSignerRequired",
        "A trusted person who is not the buyer must co-sign this sale.");
    } else {
      need(a.listingEnds !== null && nowSecs() >= a.listingEnds, "ListingStillOpen", "With no trusted people left, the sale waits until the listing ends.");
    }
    if (!o) {
      const ready = ranking.ineligible.flatMap((r) => (r.readyAt ? [r.readyAt] : []));
      if (ready.length) fail("ObjectionWindowOpen", "Monitors can still object, so no offer can be accepted yet. Try again once the window closes.");
      if (hardship) fail("BelowHardshipFloor", `No offer reaches the hardship floor of ${usd(a.hardshipFloor)}.`);
      return fail("BelowFloor", `No offer reaches the minimum price of ${usd(a.floorPrice)}.`);
    }
    const to = a.hardshipBeneficiary ?? a.proceedsTo;
    if (to === ESTATE) est().vaultBalance += o.amount; else credit(to, o.amount);
    s.snap.offers = s.snap.offers.filter((x) => x !== o);
    a.status = "Sold";
    const t = tx();
    log("AssetSold", `${a.title} sold to ${o.buyerName ?? name(o.buyer)} for ${usd(o.amount)}. ${to === ESTATE ? "The money went into the vault" : `The money went to ${first(to)}`} and the digital title moved to the buyer in the same transaction`, t, o.amount);
    s.snap.activity[0].sale = { asset: a.address, buyer: o.buyer, buyerName: o.buyerName ?? name(o.buyer), recipient: to, hardship };
    return { t, ranking };
  }

  function submitHardship(assetAddr: Base58, evidenceHash: string, report: AgentReport | null): TxResult {
    needCreated(); needBeneficiary();
    need(est().status === "Unlocked", "BadStatus", "Hardship requests open once the estate is unlocked.");
    const a = s.snap.assets.find((x) => x.address === assetAddr) ?? fail("BadStatus", "That asset does not exist.");
    need(a.status !== "Sold", "BadStatus", "The car has already been sold.");
    // Like the contract: one request per family member per car (the account is created once and never reused).
    need(!s.snap.hardships.some((h) => h.beneficiary === me() && h.asset === assetAddr), "BadStatus", "You have already asked once for this car.");
    const h: Hardship = {
      address: fakeAddr(), asset: a.address, beneficiary: me(), evidenceHash, agentVerdict: "Pending", approvals: [false, false, false], status: "Open",
    };
    s.snap.hardships.unshift(h);
    const t = tx();
    log("HardshipSubmitted", `${first(me())} asked for the car to be sold below the minimum price because of hardship`, t);
    if (report) reviewHardship(h, report);
    return t;
  }

  function reviewHardship(h: Hardship, report: AgentReport) {
    const outcome = outcomeOf(report.verdict);
    const ok = outcome !== "Reject";
    h.agentVerdict = outcome === "Approve" ? "Approved" : ok ? "Referred" : "Rejected";
    h.agentReport = report;
    h.status = ok ? "Open" : "Rejected";
    log("HardshipReviewed", ok ? "The agent checked the affidavit: commissioned, stamped and dated" : "The agent could not accept the affidavit", tx());
  }

  function approveHardship(address: Base58): TxResult {
    needCreated();
    const i = verifierIndex();
    const h = s.snap.hardships.find((x) => x.address === address) ?? fail("BadStatus", "That request does not exist.");
    const a = s.snap.assets.find((x) => x.address === h.asset) ?? fail("BadStatus", "That asset does not exist.");
    need(a.status !== "Sold", "BadStatus", "The asset has already been sold.");
    need(h.status === "Open", "BadStatus", "This request cannot be approved.");
    need(!a.hardshipBeneficiary || a.hardshipBeneficiary === h.beneficiary, "BadStatus", "Another hardship request already stands for this asset.");
    need(openToPeople(h.agentVerdict), "AgentNotApproved", "The agent has not cleared this request.");
    notInterested(h.beneficiary);
    const firstTime = !h.approvals[i];
    const votes = h.approvals.map((v, j) => v || j === i);
    const q = hardshipTally(est(), { ...h, approvals: votes });
    need(firstTime || q.met, "AlreadyApproved", "You have already approved this.");
    h.approvals = votes;
    const t = tx();
    log("HardshipApproved", `${first(me())} approved ${first(h.beneficiary)}'s hardship request (${q.got} of ${q.needed})`, t);
    G.recordApproval({ kind: "Hardship", seatIndex: i, target: h.address, t, deadline: null, summary: `Approved ${first(h.beneficiary)}'s request to sell below the minimum price` });
    if (q.met) {
      h.status = "Approved";
      a.hardshipBeneficiary = h.beneficiary;
      // Its ["stamp", hardship]: with a Guard the sale waits out the objection window from now.
      G.recordHardshipStamp(h.address, i);
    }
    return t;
  }

  /* ----- plain USD₮ transfers (the Tether payment flow) ----- */

  /** A wallet's saved bill payees; Thabo starts with his lawyer, plumber and Naledi's school (lib/bills/payees.ts). */
  function payeesOf(wallet: Base58): BillPayee[] {
    const all = (s.billPayees ??= {});
    if (!all[wallet] && wallet === s.bind.thabo) all[wallet] = structuredClone(DEMO_BILL_PAYEES);
    return all[wallet] ?? [];
  }

  /** Moves a pending send to confirmed once its (simulated) confirmation time has passed. Never re-sends. */
  function settle(id: string): PaymentReceipt | null {
    const x = s.sends[id];
    if (!x) return null;
    if (x.receipt.status === "pending" && Date.now() >= x.confirmAt) {
      credit(x.to, x.amount);
      x.receipt = { ...x.receipt, status: "confirmed", confirmations: 32, updatedAt: nowSecs() };
      s.snap.activity.unshift(x.bill
        ? { ts: nowSecs(), kind: "BillPaid", text: billActivityText(first(x.from), x.bill, usd(x.amount)), amount: x.amount, txSignature: x.receipt.signature }
        : { ts: nowSecs(), kind: "Transfer", text: `${first(x.from)} sent ${usd(x.amount)} to ${x.toLabel}`, amount: x.amount, txSignature: x.receipt.signature });
      save();
    }
    return { ...x.receipt };
  }

  /* ----- agent simulations ----- */

  // The scripted reviewer rejects by file name (docs/demo-documents/rejected/* all match).
  const suspicious = (f: File) => /fake|edit|tamper|alter|photoshop|wrong|unsigned|reject/i.test(f.name);
  async function hashFile(f: File): Promise<string> {
    try {
      const buf = await f.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { return fakeHash(); }
  }
  const zar = (usdt: number) => `R ${(usdt * DEMO_FX).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
  const today = () => new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });

  function report(purpose: "death" | "claim" | "hardship" | "seat-death" | "fallback-death", file: File, ctx: { amountUsdt?: number; payee?: string; who?: string; person?: string }): AgentReport {
    const bad = suspicious(file);
    const unsure = !bad && opts.agent?.() === "unsure";
    const verdict: AgentReport["verdict"] = bad ? "reject" : unsure ? "needs_human" : "approve";
    // A document carries plain names: the app's role labels ("Lerato Mokoena (daughter)") never show as extracted data.
    const who = fullName(ctx.who ?? (actor ? actor.label : "Applicant"));
    if (purpose === "seat-death" || purpose === "fallback-death") {
      const person = ctx.person ? fullName(ctx.person) : "the person named";
      return {
        verdict, documentType: "death_certificate",
        extracted: { "Full name": person, "Date of death": today(), "Issued by": "Department of Home Affairs", "Form": "DHA-5 (abridged death certificate)", "Serial number": "C 5528 1307", "Reported by": who },
        redFlags: bad ? ["The typeface in the name field differs from the rest of the form", "No official stamp is visible"] : [],
        confidence: bad ? 0.3 : 0.93,
        summary: bad
          ? `This does not look like a genuine Home Affairs death certificate for ${person}. Nothing has changed.`
          : purpose === "seat-death"
            ? `This is an abridged death certificate for ${person}, issued by Home Affairs. The name matches the trusted person, and I found nothing unusual. A second person must still confirm.`
            : `This is an abridged death certificate for ${person}, issued by Home Affairs. The name matches the fallback recipient. They can still say "I'm alive", and a second person must confirm after the wait before the plan skips them.`,
        reportHash: fakeHash(),
      };
    }
    if (purpose === "death") {
      const ownerName = fullName(est().ownerName);
      return {
        verdict, documentType: "death_certificate",
        extracted: { "Full name": ownerName, "Date of death": today(), "Issued by": "Department of Home Affairs", "Form": "DHA-5 (abridged death certificate)", "Serial number": "C 4471 0892", "Reported by": who },
        redFlags: bad ? ["The typeface in the name field differs from the rest of the form", "The serial number does not follow the Home Affairs pattern", "No official stamp is visible"] : [],
        confidence: bad ? 0.31 : 0.94,
        summary: bad
          ? "This does not look like a genuine Home Affairs death certificate. Parts of the form appear to have been edited. I have not passed it to the trusted people."
          : `This is an abridged death certificate for ${ownerName}, issued by Home Affairs. The name matches the estate owner, the stamp and serial number are present, and I found nothing unusual. The trusted people must still confirm.`,
        reportHash: fakeHash(),
      };
    }
    if (purpose === "claim") {
      const amount = ctx.amountUsdt ?? 0;
      return {
        verdict, documentType: "fee_statement",
        extracted: { "Student": who, "Student number": "MKNLER003", "Institution": ctx.payee ?? "Institution", "Amount due": zar(amount), "Statement date": today(), "Payment reference": "MKNLER003-2027" },
        redFlags: bad ? ["The amount due appears to have been altered", "The bank reference does not match the institution's format"] : [],
        confidence: bad ? 0.38 : 0.92,
        summary: bad
          ? "The statement appears to have been altered, so I could not accept it and have not passed it to the trusted people. Nothing was paid. You can submit a clear copy from the institution."
          : `This is a fee statement from ${ctx.payee ?? "the institution"} in ${who}'s name. The amount due is ${zar(amount)}, which matches the ${amount.toLocaleString("en-ZA")} USD₮ requested at today's rate. The payee is on the approved list.`,
        reportHash: fakeHash(),
      };
    }
    return {
      verdict, documentType: "affidavit",
      extracted: { "Deponent": who, "Commissioner of Oaths": "Sgt. T. Mahlangu, SAPS Orlando", "Station stamp": "Present, dated " + today(), "Jurat": "Present (sworn and signed)", "Stated reason": "Outstanding medical bills and three months of rent arrears", "Supporting papers": "Hospital account, landlord letter" },
      redFlags: bad ? ["No commissioner's stamp is visible", "The affidavit is not signed by the deponent"] : [],
      confidence: bad ? 0.35 : 0.88,
      summary: bad
        ? "This affidavit is missing the commissioner's stamp and a signature, so I cannot accept it. SAPS stations commission affidavits free of charge."
        : `${who} swore this affidavit at SAPS Orlando. It has the commissioner's details, a dated stamp and the sworn statement. The reason given is medical debt and rent arrears, with supporting papers. Two trusted people must agree before the car can sell below the minimum price.`,
      reportHash: fakeHash(),
    };
  }

  function draftFor(history: WillChatMessage[]): { stage: number; draft: WillDraft } {
    const userText = history.filter((m) => m.role === "user").map((m) => m.text).join(" ");
    const stage = history.filter((m) => m.role === "user").length;
    const floor = floorFromText(userText);
    const ownerName = actor?.label ?? "Thabo Mokoena";
    const draft: WillDraft = {
      ownerName,
      beneficiaries: [
        { label: "Lerato Mokoena", relationship: "daughter" },
        { label: "Sipho Mokoena", relationship: "son" },
        { label: "Naledi Mokoena", relationship: "daughter" },
      ],
      verifiers: stage >= 2 ? [
        { name: "Adv. Thandi Ndlovu", role: "Executor named in your will" },
        { name: "Ms. Anita Pillay", role: "Family attorney" },
        { name: "Uncle Bongani Mokoena", role: "Your brother" },
      ] : [],
      rules: [
        { beneficiaryLabel: "Lerato", category: "Books", allowedPayeeKind: "Other", maxPerClaimUsdt: 85, lifetimeCapUsdt: 3000, validUntil: "2030-12-31", notes: "Monthly book allowance (about R1,500), paid to the bookstore account", startsNow: true, recurring: { amountUsdt: 85, every: "month", payeeName: "Van Schaik Bookstore" } },
        { beneficiaryLabel: "Lerato", category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 3500, lifetimeCapUsdt: 14000, validUntil: "2030-12-31", notes: "University fees, paid to the university only. You approve while you are here", startsNow: true },
        { beneficiaryLabel: "Lerato", category: "General", allowedPayeeKind: "Other", maxPerClaimUsdt: 60, lifetimeCapUsdt: 720, validUntil: "2030-12-31", notes: "Everyday needs (a school trip, transport, data), up to 60 USD₮ (about R1,100) a time, paid to her own wallet or the bookstore. She asks, you approve each one", startsNow: true },
        { beneficiaryLabel: "Lerato", category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaimUsdt: 450, lifetimeCapUsdt: 6000, validUntil: "2030-12-31", notes: "Residence rent every month, paid to the residence", startsNow: false, recurring: { amountUsdt: 450, every: "month", payeeName: "South Point Student Residences" } },
        { beneficiaryLabel: "Sipho", category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 3500, lifetimeCapUsdt: 14000, validUntil: "2032-12-31", notes: "University fees, paid to the university only", startsNow: false },
        { beneficiaryLabel: "Naledi", category: "Tuition", allowedPayeeKind: "School", maxPerClaimUsdt: 1500, lifetimeCapUsdt: 9000, validUntil: "2034-12-31", notes: "High school fees now, university later by a new rule", startsNow: false },
      ],
      assets: stage >= 3 ? [{
        title: DEMO_ASSETS.corolla.title,
        // 12,500 minimum → 10,500 hardship floor and 13,500 asking (Tumo's prices for the 2017 Corolla).
        floorPriceUsdt: floor, hardshipFloorUsdt: Math.round(floor * 0.84 / 50) * 50, askingPriceUsdt: Math.round(floor * 1.08 / 50) * 50,
        proceedsTo: "The family vault, to fund the children's rules",
        hardshipPolicy: "May sell below the minimum only if a child proves real hardship with a sworn affidavit and two trusted people agree. Never below the hardship floor.",
      }] : [],
      waitingPeriodDays: 30,
      plainLanguageSummary: stage >= 3
        ? `Starting now, Lerato's book allowance is paid every month, and you approve her university fees and her everyday requests (up to 60 USD₮ a time) yourself. After two of your three trusted people confirm your passing and 30 days go by, the same plan carries on without you: rent, school and university fees are paid straight to approved payees, within the limits you set. Your Corolla can sell only at or above ${floor.toLocaleString("en-ZA")} USD₮, with a trusted person co-signing the offer the agent ranks best, and the money goes into the family vault. Whatever no rule needs goes to the person you name. Nothing is paid to anyone in cash.`
        : "Three rules start now (Lerato's book allowance, her university fees and her everyday needs) and three carry on after you're gone. Every rule pays straight to an approved payee. We still need to settle who confirms your passing and what happens to the car.",
    };
    return { stage, draft };
  }

  /* ----- stage seeding for the demo ----- */

  function as<T>(key: PersonaKey | "agent", fn: () => T): T {
    const prev = actor;
    const p = DEMO_PERSONAS.find((x) => x.key === key);
    actor = key === "agent" ? { address: AGENT, role: "agent", label: "Heirloom agent" } : { address: s.bind[key], role: p!.role, label: p!.label };
    try { return fn(); } finally { actor = prev; }
  }

  function asAddr<T>(address: Base58, role: Role, label: string, fn: () => T): T {
    const prev = actor;
    actor = { address, role, label };
    try { return fn(); } finally { actor = prev; }
  }

  /**
   * Thabo's guardians: Bongani's backups are Kagiso then Adv. Naidoo; Aunt Zodwa watches Bongani; fallback to the children,
   * then a charity. Every seat has a monitor (plan §18.8): Adv. Naidoo watches the executor, Kagiso the attorney.
   */
  function demoGuardianInput(): { seats: { index: number; backups: Named[]; monitors: Named[] }[]; fallback: FallbackInput[] } {
    const b = s.bind;
    return {
      seats: [
        { index: 0, backups: [], monitors: [{ ...DEMO_GUARDIANS.priya }] },
        { index: 1, backups: [], monitors: [{ ...DEMO_GUARDIANS.kagiso }] },
        { index: 2, backups: [{ ...DEMO_GUARDIANS.kagiso }, { ...DEMO_GUARDIANS.priya }], monitors: [{ wallet: b.zodwa, name: "Aunt Zodwa Mokoena" }] },
      ],
      fallback: [
        { wallet: b.lerato, name: "Lerato (daughter)", kind: "family" },
        { wallet: b.sipho, name: "Sipho (son)", kind: "family" },
        { wallet: b.naledi, name: "Naledi (daughter)", kind: "family" },
        { ...DEMO_GUARDIANS.charity, kind: "charity" },
      ],
    };
  }

  const certificate = () => new File(["demo"], "death-certificate.pdf");

  /** Thabo's passing reported by Lerato (or the family member still in the plan) and cleared by the agent (no confirmations yet). */
  function reportOwnerPassing() {
    if (est().death.certHash) return;
    const who = anyFamily() ?? fail("NotBeneficiary", "Nobody in the family is left to report it.");
    asAddr(who.wallet, "beneficiary", name(who.wallet), () => submitDeath(fakeHash(), report("death", certificate(), { who: name(who.wallet) })));
  }

  function seed(stage: DemoStage) {
    s = blank();
    if (stage === "fresh") return;
    const { draft } = draftFor([{ role: "user", text: "a" }, { role: "user", text: "b" }, { role: "user", text: "c" }]);
    draft.ownerName = "Thabo Mokoena";
    as("thabo", () => {
      createEstate(draft);
      addOwnWallets(draft);
      deposit(24000);
      // Naledi's school fees: at most 3,000 USD₮ a year (yearly cap), on top of 1,500 per claim and 9,000 in total.
      const school = s.snap.rules.find((r) => r.category === "Tuition" && r.allowedPayeeKind === "School");
      if (school) D.setYearlyCap(school.address, toBase(3000));
      addNalediGift();
      const car = draft.assets[0];
      // Adds the Corolla with its photos and spec sheet, and the motorbike with its own (see registerAsset).
      registerAsset({ nftMint: CAR_MINT, title: car.title, floorUsdt: car.floorPriceUsdt, hardshipFloorUsdt: car.hardshipFloorUsdt, askingUsdt: car.askingPriceUsdt, proceedsTo: ESTATE }, fakeHash());
      // Only the guardians stage has a Guard, so the stock demo (approve, then pay at once) is unchanged.
      if (stage === "guardians") G.setup(demoGuardianInput());
      // The plan was signed a moment before the story's next step: the program compares these times strictly.
      est().lastHeartbeat -= 1;
    });
    as("thabo", () => {
      const allowance = s.snap.rules.find((r) => r.startsNow && r.recurringAmount > 0n);
      if (allowance) executeScheduled(allowance.address, true);
    });
    if (stage === "funded") {
      // Everyday money: Lerato has asked for her field trip, so Thabo's chat home shows the request to approve.
      const everyday = s.snap.rules.find((r) => r.category === "General" && r.startsNow && r.beneficiary === s.bind.lerato);
      const own = s.snap.payees.find((p) => p.wallet === s.bind.lerato);
      if (everyday && own) as("lerato", () => A.seedAsk({ rule: everyday.address, payee: own.wallet, amountUsdt: Math.round((350 / DEMO_FX) * 100) / 100, purpose: "Geology field trip to the Cradle of Humankind", typed: 350 }));
      return;
    }
    reportOwnerPassing();
    as("nomsa", attestDeath);
    as("david", attestDeath);
    finalizeUnlock(true);
    if (stage === "unlocked" || stage === "guardians") return;
    as("nomsa", () => listAsset(s.snap.assets[0].address, 7 * 86400, stage === "lowOffers" ? "low" : "both"));
  }

  /* ----- public API ----- */

  const mutate = async <T>(ms: number, fn: () => T): Promise<T> => {
    await wait(ms);
    const out = fn();
    save();
    return out;
  };

  const legacy = createMockLegacy({
    actor: () => actor, estate: est, snap: () => s.snap, created: () => s.created,
    wallets: { lerato: s.bind.lerato, sipho: s.bind.sipho, naledi: s.bind.naledi },
  });
  const { resetLegacy, ...legacyMethods } = legacy;

  /** confirmSend's one run per payment id (see M8 above). */
  const confirming = new Map<string, Promise<PaymentReceipt>>();
  async function confirmOnce(review: PaymentReview): Promise<PaymentReceipt> {
      const existing = s.sends[review.id];
      if (existing) return { ...existing.receipt }; // idempotent: a retry never pays twice
      await wait(1200); // signing with the WDK wallet
      // Checked before the balance moves, so nothing waits between paying and recording the payment.
      const bill = review.bill ? (await billSchemas()).billDetailsSchema.parse(review.bill) : undefined;
      need(me() === review.from, "NotOwner", "This payment was prepared by a different wallet.");
      need((s.balances[review.from] ?? 0n) >= review.amount, "InsufficientFunds", "Your wallet does not hold that much USD₮.");
      s.balances[review.from] -= review.amount;
      const t = tx();
      const receipt: PaymentReceipt = { id: review.id, status: "pending", signature: t.signature, explorerUrl: t.explorerUrl, confirmations: 0, updatedAt: nowSecs() };
      s.sends[review.id] = { receipt, from: review.from, to: review.to, toLabel: review.toLabel, amount: review.amount, confirmAt: Date.now() + 2000 + Math.floor(Math.random() * 2000), ts: nowSecs(), ...(bill ? { bill } : {}) };
      save();
      return { ...receipt };
  }

  return {
    mode: "mock",
    ...legacyMethods,

    setActor(a) {
      actor = a;
      if (!a) return;
      if (!(a.address in s.names)) {
        // A wallet the user created themselves: give it a name and demo funds.
        s.names[a.address] = a.label;
        if (!(a.address in s.balances)) s.balances[a.address] = a.role === "owner" ? toBase(25000) : a.role === "buyer" ? toBase(16000) : 0n;
        save();
      }
    },
    resetDemo(stage) { seed(stage); save(); resetLegacy(); },

    async reviewSend({ to, toLabel, amountUsdt, bill }) {
      await wait(500);
      const from = me();
      const dest = to.trim();
      need(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest), "InvalidAddress", "That is not a valid Solana address.");
      const amount = toBase(amountUsdt);
      need(amount > 0n, "InvalidAmount", "Enter an amount above zero.");
      const details = bill ? (await billSchemas()).billDetailsSchema.parse(bill) : undefined;
      const balance = s.balances[from] ?? 0n;
      const known = dest in s.names || payeesOf(from).some((p) => p.wallet === dest);
      const warnings: string[] = [];
      if (dest === from) warnings.push("This is your own wallet. Sending to yourself only costs the fee.");
      if (!known) warnings.push("You have not sent to this address before. Check it carefully: transfers cannot be reversed.");
      if (!(dest in s.balances)) warnings.push("The recipient has no USD₮ account yet: it will be created, and Heirloom covers the cost.");
      const review: PaymentReview = {
        id: `pay_${rand(16, B58)}`, kind: details ? "bill" : "p2p", from, to: dest, toLabel: toLabel || details?.payee || name(dest), amount, ...(details ? { bill: details } : {}),
        token: { symbol: "USD₮", mint: est().usdtMint, verified: true },
        network: { name: "Solana devnet", cluster: "devnet" },
        // Like chain mode with the sponsor on: Heirloom's sponsor wallet pays the network fee (rent still needs a little SOL).
        fee: { lamports: 10000, sol: 0.00001, payer: AGENT, sponsored: true },
        balances: { usdt: balance, sol: 0.5, sufficient: balance >= amount },
        warnings, simulated: true,
      };
      return review;
    },
    async quoteFee(_e, q) {
      await wait(150);
      // As on a network with Heirloom's sponsor on: it pays the fee, accounts a payment creates cost rent.
      const rent = (bytes: number) => (bytes + 128) * 6960;
      let userRent = 0;
      if ((q.kind === "claim-payout" || q.kind === "scheduled") && !(q.to in s.balances)) userRent += rent(165);
      if (q.kind === "offer" && !s.snap.offers.some((o) => o.asset === q.to && o.buyer === me())) userRent += rent(89) + rent(165);
      const network = q.selfPay ? 5_000 : 10_000 * (1 + (q.approve ? 1 : 0));
      const lamports = network + (q.selfPay ? userRent : 0);
      return {
        fee: { lamports, sol: lamports / 1e9, payer: q.selfPay ? me() : AGENT, sponsored: !q.selfPay, networkLamports: network, rentLamports: userRent, ...(userRent ? { rentPayer: me() } : {}) },
        userLamports: (q.selfPay ? network : 0) + userRent, solBalance: 0.5,
      };
    },
    withShownFee: (_fee, work) => work(),
    confirmSend(review) {
      // Two confirms of one id share the first (M8): the balance moves once.
      const running = confirming.get(review.id);
      if (running) return running;
      const run = confirmOnce(review).finally(() => confirming.delete(review.id));
      confirming.set(review.id, run);
      return run;
    },
    async getReceipt(id) {
      await wait(350);
      return settle(id);
    },
    async listPendingReceipts() {
      await wait(200);
      return Object.keys(s.sends).map((id) => settle(id)!).filter((r) => r.status === "pending" || r.status === "submitted");
    },
    async savedRecipients() {
      await wait(150);
      const self = actor?.address;
      const out: SavedRecipient[] = s.created
        ? [
          ...s.snap.beneficiaries.filter((b) => b.active).map((b) => ({ label: b.label.replace(/\s*\(.*\)$/, ""), address: b.wallet, relationship: b.label.match(/\((.*)\)/)?.[1] })),
          ...est().verifiers.map((v, i) => ({ label: est().verifierNames[i], address: v, relationship: i === 0 ? "executor" : "trusted person" })).filter((r) => isHeld(r.address)),
          { label: est().ownerName, address: est().owner, relationship: "estate owner" },
        ]
        : DEMO_PERSONAS.filter((p) => p.role !== "buyer").map((p) => ({ label: p.label, address: p.address, relationship: p.relation.toLowerCase() }));
      return out.filter((r) => r.address !== self);
    },

    /* ----- pay a bill once: Thabo's own wallet, never the vault ----- */
    async billPayees() {
      await wait(150);
      return structuredClone(payeesOf(me()));
    },
    async saveBillPayee(input) {
      await wait(300);
      const owner = me();
      const { list, payee } = (await billSchemas()).upsertPayee(payeesOf(owner), input);
      (s.billPayees ??= {})[owner] = list;
      if (!(payee.wallet in s.names)) s.names[payee.wallet] = payee.name;
      save();
      return { ...payee };
    },
    async readInvoice(chosen) {
      const file = await requireEvidence(chosen);
      await wait(1400); // "the AI is reading it"
      // Scripted by file name (lib/bills/demo.ts) and labelled as a demo on screen. Only the hash is kept, never the file.
      return { reading: demoInvoiceReading(file.name), sha256: await hashFile(file), engine: "demo" as const };
    },
    async paidBills() {
      await wait(150);
      const self = me();
      return Object.entries(s.sends)
        .filter(([, x]) => x.bill && x.from === self)
        .map(([id, x]) => { const r = settle(id)!; return { id, to: x.to, bill: x.bill!, amount: x.amount, status: r.status, signature: r.signature, explorerUrl: r.explorerUrl, ts: x.ts ?? r.updatedAt }; })
        .sort((a, b) => b.ts - a.ts);
    },
    simulatePassing() {
      needCreated();
      need(est().status === "Active", "BadStatus", "A passing is already being confirmed.");
      reportOwnerPassing();
      // The trusted people who may still confirm do, until the quorum starts the wait.
      for (const [i, v] of est().verifiers.entries()) {
        if (est().status !== "Active") break;
        if (!isHeld(v) || v === est().death.submittedBy || (est().death.attestations[i] && !deathTally(est()).met)) continue;
        asAddr(v, "verifier", name(v), attestDeath);
      }
      save();
    },
    skipWait() { finalizeUnlock(true); save(); },
    setCheckInDaysLeft(daysLeft) {
      needCreated();
      need(est().status === "Active", "BadStatus", "Check-ins only count while the estate is active.");
      est().lastHeartbeat = heartbeatFor(daysLeft, nowSecs(), checkInPlan("mock"));
      save();
    },
    makeDue() {
      needCreated();
      for (const r of s.snap.rules) if (r.recurringAmount > 0n && r.nextDue !== null) r.nextDue = nowSecs();
      save();
    },
    balanceOf(address) { return s.balances[address] ?? null; },

    setupDemoGuardians() {
      needCreated();
      as("thabo", () => G.setup(demoGuardianInput()));
      save();
    },
    simulateSeatApproval(index = 2) {
      needCreated();
      const holder = est().verifiers[index];
      need(!!holder && holder !== VACANT_KEY, "SeatVacant", "This seat is empty.");
      const unlocked = est().status === "Unlocked";
      if (!unlocked) {
        // While Thabo is alive only he approves claims: what a trusted person can approve is a reported passing.
        need(est().status === "Active" && !!est().death.certHash, "BadStatus", "Trusted people approve claims only after the estate unlocks.");
        asAddr(holder, "verifier", name(holder), attestDeath);
        save();
        return;
      }
      // Lerato's university fees: after unlock the legacy rule, before it the living-plan rule.
      const rule = s.snap.rules.find((r) => r.category === "Tuition" && r.beneficiary === s.bind.lerato)
        ?? fail("BadStatus", "There is no claim Lerato could make yet.");
      const payee = s.snap.payees.find((p) => p.kind === rule.allowedPayeeKind) ?? fail("BadStatus", "There is no approved institution.");
      let claim = s.snap.claims.find((c) => c.rule === rule.address && c.status === "Open" && !c.approvals[index] && isCurrent(c, rule));
      if (!claim) {
        const amountUsdt = Math.min(3500, fromBase(rule.maxPerClaim));
        const r = report("claim", new File(["demo"], "fee-statement.pdf"), { amountUsdt, payee: payee.name, who: "Lerato Mokoena" });
        claim = as("lerato", () => submitClaim({ rule: rule.address, payee: payee.wallet, amountUsdt }, fakeHash(), r)).claim;
      }
      const target = claim.address;
      asAddr(holder, "verifier", name(holder), () => approveClaim(target));
      save();
    },
    simulateSeatPassing(index = 2) {
      needCreated();
      const st = G.seat(index);
      const holder = st.holder ?? fail("SeatVacant", "This seat is empty.");
      if (!st.succession) {
        // Reported by a monitor of the seat (Aunt Zodwa for Bongani), else by Lerato.
        const reporter = st.monitors[0] ?? anyFamily()?.wallet ?? est().owner;
        asAddr(reporter, "monitor", name(reporter), () =>
          G.reportSeatDeath(index, fakeHash(), report("seat-death", certificate(), { person: name(holder), who: name(reporter) })));
      }
      const sc = G.seat(index).succession;
      if (sc && !sc.confirmedBy) {
        const others = G.otherLivingHolders(index);
        const watchers = [st.backups[1], ...st.monitors].filter((w): w is Base58 => !!w);
        const pool = others.length ? others : watchers.length ? watchers : s.snap.beneficiaries.filter((b) => b.active).map((b) => b.wallet);
        const confirmer = pool.find((w) => w !== sc.reportedBy && w !== st.backups[0]) ?? fail("NotConfirmer", "Nobody is left who can confirm this.");
        asAddr(confirmer, "verifier", name(confirmer), () => G.confirmSeatDeath(index));
      }
      save();
    },
    endObjectionWindow() {
      G.endObjectionWindow();
      // Offers wait out the same window; never back past an upheld objection to their sale.
      const back = s.guard?.objectionWindowSecs ?? 0;
      for (const o of s.snap.offers) {
        const a = s.snap.assets.find((x) => x.address === o.asset);
        const upheld = a ? G.saleTiming(a).saleObjectionUpheldAt : null;
        o.createdAt = Math.max(o.createdAt - back, upheld === null ? -Infinity : upheld + 1);
      }
      save();
    },
    endSuccessionWait() { G.endSuccessionWait(); save(); },
    endFallbackWait() { G.endFallbackWait(); save(); },
    simulateAllSeatsVacant() {
      needCreated();
      G.vacateAllSeats();
      if (est().status === "Active") reportOwnerPassing();
      save();
    },

    async getEstate() {
      await wait(120);
      needCreated();
      const { claims, disputes, ...rest } = s.snap;
      return {
        ...structuredClone(rest),
        claims: claims.map((c) => ({
          ...structuredClone(c),
          fromEndedRule: !isCurrent(c, s.snap.rules.find((r) => r.address === c.rule)),
          approvalsCount: !count(c.approvals) || G.countsFor(c),
        })),
        ...(disputes ? { disputes: D.snapshot() } : {}),
        residual: residualNow(),
        agentVotes: C.agentVotes(),
        names: { ...s.names },
        guardians: G.snapshot(),
        asks: structuredClone(s.asks ?? {}),
        ...(s.planned?.length ? { plannedAssets: structuredClone(s.planned) } : {}),
      };
    },
    async listEstatesFor(wallet) {
      await wait(80);
      if (!s.created) return [];
      const e = est();
      // Backups and the fallback list see the estate in their list, as monitors do.
      const monitor = !!s.guard?.enabled && (s.guard.seats.some((x) => x.monitors.includes(wallet) || x.backups.includes(wallet))
        || s.guard.fallback.some((x) => x.wallet === wallet));
      const role = wallet === e.owner ? "owner" : e.verifiers.includes(wallet) ? "verifier" : s.snap.beneficiaries.some((b) => b.wallet === wallet && b.active) ? "beneficiary" : monitor ? "monitor" : "buyer";
      return [{ estate: e.address, role, ownerName: e.ownerName }];
    },
    async getFx() {
      await wait(60);
      return { usdtZar: DEMO_FX, source: "VALR (demo rate)", fetchedAt: nowSecs() };
    },

    async willChat(history) {
      await wait(1100);
      const { stage, draft } = draftFor(history);
      const firstName = draft.ownerName.split(" ")[0];
      const reply = stage <= 1
        ? `Thank you, ${firstName}. I've set that up as a plan in two parts. Starting now: Lerato's book allowance of 85 USD₮ (about R1,500) goes to the bookstore every month, and her university fees are paid to the university when you approve them. She can also ask you for everyday needs, up to 60 USD₮ a time, and you approve each one. After you're gone: rent, school and university fees for all three carry on, paid straight to the institution, never in cash. You can switch any rule between "Now" and "After I'm gone" in the plan beside this chat.\n\nWho should confirm your passing when the time comes? Most people choose three: the executor named in their will, and two people the family trusts. Any two of them must agree.`
        : stage === 2
          ? `Good choices. Adv. Ndlovu, Ms. Pillay and your brother Bongani are now your three trusted people. Two of them must confirm before anything unlocks, and then a 30 day waiting period runs. You can cancel it with one tap if a report is ever wrong.\n\nLast thing: the car. What is the lowest price you would accept for the Corolla, and should that ever bend if one of the children is in real need?`
          : `Understood. The Corolla can sell only at or above ${draft.assets[0]?.floorPriceUsdt.toLocaleString("en-ZA")} USD₮: the agent ranks the offers and a trusted person co-signs the one that's accepted. Below that, only if one of your children proves hardship with a sworn affidavit and two trusted people agree, and never below ${draft.assets[0]?.hardshipFloorUsdt.toLocaleString("en-ZA")} USD₮. The money goes into the family vault.\n\nYour rules are ready. Please read them in plain language before you sign.`;
      return { reply, draft };
    },
    async reviewDocument({ file: chosen, purpose, context }) {
      const file = await requireEvidence(chosen);
      await wait(1600);
      return report(purpose, file, { payee: context });
    },
    async valueCar(input) {
      await wait(1700);
      return estimateValuation(input, DEMO_FX);
    },
    async rankOffers(asset) {
      await wait(300);
      needCreated();
      return rank(asset).ranking;
    },

    async createEstateFromWill(draft, opts) {
      // Kept before the wait (H6): a reload while "signing" offers to finish it, as on-chain.
      s.signing = { draft: structuredClone(draft), options: { ...opts } };
      save();
      const txs = await mutate(1500, () => createEstate(draft, opts?.residualLabel, opts?.practice));
      s.planned = draft.assets.length ? structuredClone(draft.assets) : undefined;
      delete s.signing;
      save();
      return { estate: est().address, txs };
    },
    async unfinishedSigning() {
      await wait(60);
      return s.signing && !s.created ? structuredClone(s.signing) : null;
    },
    deposit: (_e, amountUsdt) => mutate(900, () => deposit(amountUsdt)),
    withdraw: (_e, amountUsdt) => mutate(900, () => withdraw(amountUsdt)),
    heartbeat: () => mutate(600, heartbeat),
    async registerAsset(_e, input) {
      const docHash = input.docFile ? await hashFile(await requireEvidence(input.docFile)) : fakeHash();
      return mutate(1000, () => registerAsset(input, docHash));
    },
    addPayee: (_e, input) => mutate(700, () => addPayee(input)),
    addRule: (_e, input) => mutate(700, () => addRule(input)),
    ownerApproveClaim: (_e, claim) => mutate(900, () => ownerApproveClaim(claim)),
    executeScheduled: (_e, rule, shown) => mutate(1000, () => executeScheduled(rule, false, shown)),
    vetoDeath: () => mutate(800, vetoDeath),
    askForMoney: (e, input) => A.askForMoney(e, input),
    getTree: async (e) => (await Tr()).getTree(e),
    setRelationship: async (e, input) => (await Tr()).setRelationship(e, input),
    removeRelationship: async (e, id) => (await Tr()).removeRelationship(e, id),
    setHidden: async (e, hidden) => (await Tr()).setHidden(e, hidden),
    setPhoto: async (e, person, src) => (await Tr()).setPhoto(e, person, src),
    removePhoto: async (e, person) => (await Tr()).removePhoto(e, person),
    declineAsk: (e, claim) => A.declineAsk(e, claim),
    listLetters: async (e, opts) => (await Lt()).listLetters(e, opts),
    saveLetter: async (e, input, version) => (await Lt()).saveLetter(e, input, version),
    deleteLetter: async (e, id, version) => (await Lt()).deleteLetter(e, id, version),
    reviewLetter: async (e, draft, locale) => (await Lt()).reviewLetter(e, draft, locale),
    suggestLetter: async (e, input, locale) => (await Lt()).suggestLetter(e, input, locale),
    letterCounts: async (e) => (await Lt()).letterCounts(e),

    async submitDeathClaim(_e, chosen) {
      const certificate = await requireEvidence(chosen);
      checkDeathSubmission();
      const hash = await hashFile(certificate);
      await wait(1900);
      const r = report("death", certificate, {});
      const t = submitDeath(hash, unreviewed() ? null : r);
      save();
      return { tx: t, report: r };
    },
    async submitClaim(_e, chosen) {
      const input = { ...chosen, evidence: await requireEvidence(chosen.evidence) };
      const hash = await hashFile(input.evidence);
      await wait(1900);
      const payee = s.snap.payees.find((p) => p.wallet === input.payee);
      const r = report("claim", input.evidence, { amountUsdt: input.amountUsdt, payee: payee?.name });
      const { t, claim } = submitClaim(input, hash, unreviewed() ? null : r);
      save();
      if (unreviewed()) fail("ReviewPending", "It was sent, but the agent's review didn't finish. Ask for the review again from the request, with the same file.");
      return { tx: t, claim: claim.address, report: r };
    },
    async submitHardship(_e, chosen) {
      const input = { ...chosen, evidence: await requireEvidence(chosen.evidence) };
      const hash = await hashFile(input.evidence);
      await wait(1900);
      const r = report("hardship", input.evidence, {});
      const t = submitHardship(input.asset, hash, unreviewed() ? null : r);
      save();
      if (unreviewed()) fail("ReviewPending", "It was sent, but the agent's review didn't finish. Ask for the review again from the request, with the same file.");
      return { tx: t, report: r };
    },

    async requestReview(_e, { kind, subject, evidence }) {
      const file = evidence ? await requireEvidence(evidence) : null;
      const hash = file ? await hashFile(file) : null;
      await wait(1600);
      const item = kind === "claim" ? s.snap.claims.find((c) => c.address === subject) : s.snap.hardships.find((h) => h.address === subject);
      if (!item) fail("BadStatus", "That request does not exist.");
      need(item!.beneficiary === me(), "forbidden", "Only the person who sent this can ask for its review.");
      need(item!.agentVerdict === "Pending", "already_reviewed", "The agent has already reviewed this.");
      // A request sent without a letter: the app's own note is the document, so nothing is chosen.
      const noLetter = kind === "claim" && s.asks?.[subject]?.attachment === false;
      need(noLetter || hash === item!.evidenceHash, "hash_mismatch", "This isn't the file that was sent. Choose that same file.");
      need(!unreviewed(), "agent_limit", "The agent can't review this just now. Try again later.");
      const doc = file ?? new File(["request"], "request-note.pdf");
      let r: AgentReport;
      if (kind === "claim") {
        const c = item as Claim;
        r = noLetter
          ? mockAskReport({ purpose: s.asks![subject].purpose, amountUsdt: fromBase(c.amount), zar: zar(fromBase(c.amount)), who: first(c.beneficiary), payee: name(c.payee), file: null, suspicious: false, hash: fakeHash() })
          : report("claim", doc, { amountUsdt: fromBase(c.amount), payee: name(c.payee) });
        reviewClaim(c, r);
      } else {
        r = report("hardship", doc, {});
        reviewHardship(item as Hardship, r);
      }
      save();
      return { tx: tx(), report: r };
    },

    attestDeath: () => mutate(900, attestDeath),
    approveClaim: (_e, claim) => mutate(900, () => approveClaim(claim)),
    approveHardship: (_e, h) => mutate(900, () => approveHardship(h)),
    finalizeUnlock: () => mutate(800, () => finalizeUnlock()),
    executeClaim: (_e, claim) => mutate(1100, () => executeClaim(claim)),

    endRule: (_e, rule) => mutate(900, () => endRule(rule)),
    setResidual: (_e, recipient) => mutate(900, () => setResidual(recipient)),
    sweepResidual: () => mutate(900, () => sweepResidual()),
    setAgent: (_e, agent) => mutate(900, () => C.setAgent(agent)),
    voteAgent: (_e, candidate) => mutate(900, () => C.voteAgent(candidate)),
    releaseAsset: (_e, asset) => mutate(900, () => C.releaseAsset(asset)),
    removeMember: (_e, input) => mutate(1100, () => C.removeMember(input)),
    restoreMember: (_e, wallet) => mutate(900, () => C.restoreMember(wallet)),
    requestStarter: async () => fail("BadStatus", "The demo family already has simulated money."),
    listAsset: (_e, asset, durationSecs) => mutate(900, () => listAsset(asset, durationSecs)),
    placeOffer: (_e, asset, amountUsdt, buyerName) => mutate(1000, () => placeOffer(asset, amountUsdt, buyerName)),
    withdrawOffer: (_e, asset) => mutate(800, () => withdrawOffer(asset)),
    async acceptBestOffer(_e, asset, seen) {
      const { t, ranking } = await mutate(1600, () => acceptBest(asset, seen));
      return { tx: t, ranking };
    },

    /* ----- guardians (docs/guardians-spec.md; rules in mock-guardians.ts) ----- */
    async getGuardians() {
      await wait(100);
      needCreated();
      return G.snapshot();
    },
    setupGuardians: (_e, input) => mutate(1400, () => G.setup(input)),
    setSeatBackups: (_e, index, backups) => mutate(800, () => {
      for (const b of backups) if (!(b.wallet in s.names)) s.names[b.wallet] = b.name;
      return G.setBackups(index, backups.map((b) => b.wallet));
    }),
    setSeatMonitors: (_e, index, monitors) => mutate(800, () => {
      for (const m of monitors) if (!(m.wallet in s.names)) s.names[m.wallet] = m.name;
      return G.setMonitors(index, monitors.map((m) => m.wallet));
    }),
    setFallback: (_e, recipients) => mutate(800, () => G.setFallback(recipients)),
    ownerReplaceSeat: (_e, index, newHolder) => mutate(900, () => G.replaceSeat(index, newHolder)),

    async reportSeatDeath(_e, index, chosen) {
      const certificate = await requireEvidence(chosen);
      needCreated();
      const holder = G.seat(index).holder ?? fail("SeatVacant", "This seat is already empty.");
      const hash = await hashFile(certificate);
      await wait(1900);
      const r = report("seat-death", certificate, { person: name(holder) });
      const t = G.reportSeatDeath(index, hash, unreviewed() ? null : r);
      save();
      return { tx: t, report: r };
    },
    confirmSeatDeath: (_e, index) => mutate(900, () => G.confirmSeatDeath(index)),
    vetoSeatDeath: (_e, index) => mutate(800, () => G.vetoSeatDeath(index)),
    finalizeSuccession: (_e, index) => mutate(900, () => G.finalizeSuccession(index)),

    async raiseObjection(_e, input) {
      const reasonHash = await sha256Hex(input.reason.trim());
      return mutate(900, () => { D.checkObjectionAllowed(input.kind, input.target); return G.raiseObjection(input, reasonHash); });
    },

    /* ----- disputes and yearly caps (docs/program-spec.md; rules in mock-disputes.ts) ----- */
    async raiseDispute(_e, input) {
      const reason = input.reason.trim();
      const reasonHash = await sha256Hex(reason);
      return mutate(900, () => D.raiseDispute(input.kind, input.target, reason, reasonHash));
    },
    resolveDispute: (_e, dispute, uphold) => mutate(900, () => D.resolveDispute(dispute, uphold)),
    setYearlyCap: (_e, rule, input) => mutate(700, () => D.setYearlyCap(rule, toBase(input.capUsdt), input.periodStart)),
    voteObjection: (_e, objection, uphold) => mutate(900, () => G.voteObjection(objection, uphold)),

    async reportFallbackDeath(_e, i, chosen) {
      const certificate = await requireEvidence(chosen);
      needCreated();
      const person = s.guard?.fallback[i]?.name ?? fail("NoFallbackRecipient", "That fallback recipient does not exist.");
      const hash = await hashFile(certificate);
      await wait(1900);
      const r = report("fallback-death", certificate, { person });
      const t = G.reportFallbackDeath(i, hash, unreviewed() ? null : r);
      save();
      return { tx: t, report: r };
    },
    resolveFallbackDeath: (_e, i, dead) => mutate(900, () => G.resolveFallbackDeath(i, dead)),
    startFallback: () => mutate(900, () => G.startFallback()),
    lapseObjection: () => mutate(800, () => G.lapseObjection()),
    executeFallback: () => mutate(1200, () => {
      // An open challenge to the unlock (a monitors' objection or a dispute: the estate's one challenge account) blocks it.
      G.checkNotObjected(est().address);
      D.checkNotDisputed(est().address);
      const t = G.executeFallback();
      startSchedules();
      return t;
    }),

    async getAssetMedia() {
      await wait(100);
      needCreated();
      return G.assetMedia();
    },
    async setAssetMedia(_e, asset, input) {
      // The spec sheet's zod schema loads with the first save, not with the demo.
      const { specInputSchema } = await import("../assets/spec-schema");
      const checked = input.spec === undefined ? undefined : specInputSchema.safeParse(input.spec);
      const root = await mediaRootHex(input.photos, cleanSpec(checked?.success ? checked.data : undefined));
      return mutate(900, () => G.setAssetMedia(asset, input, root, checked));
    },
  };
}
