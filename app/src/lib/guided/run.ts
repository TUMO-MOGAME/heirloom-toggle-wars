/**
 * The guided run's steps (plan §22.2), on whichever service the site runs: the demo's simulated one or devnet. Each
 * step uses the app's own flows (starter funds, practice wallets, signing the plan, deposit, claim, the agent's review,
 * the owner's approval, the payout) and checks what is already done first, so a retry or a resume never pays twice.
 * Nothing here signs: every transaction is signed by a wallet on this device, through `deps.as`.
 */
import type { Base58, Claim, WillDraft } from "../types";
import type { EstateSnapshot, HeirloomService, TxResult } from "../service/types";
import { PROGRAM_ERRORS } from "../chain/program-errors";
import {
  failStep, finishStep, nextStep, overCapAmount, startStep, checkPlan,
  type GuidedState, type GuidedStepId, type GuidedTx, type SamplePlan, type StepError, type StepNote,
} from "./machine";

/** The sample family. The child's name matches Heirloom's demo fee statement, so the agent can check it. */
export const SAMPLE_CHILD = "Lerato Mokoena";
export const SAMPLE_TRUSTED = ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"] as const;
export const SAMPLE_UNTIL = "2029-12-31";
/** Heirloom's demo fee statement for Lerato (docs/demo-documents, served from public/demo/documents). */
export const SAMPLE_DOCUMENT = "/demo/documents/2-uct-fee-statement-lerato.pdf";
/** The death quorum and waiting period the plan asks for (the program's floors: 2 people, at least 300 s). */
export const SAMPLE_WAITING_DAYS = 30;

/** The words the signed plan carries, in the reader's language (content/guided.ts `draft`). */
export interface DraftWords {
  relationship: string;
  trustedRoles: readonly string[];
  notes: string;
  /** {child}, {perClaim}, {total}, {until} */
  summary: string;
}

const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/** The ready-made plan: one child, university fees paid only to a university, a cap per claim and in total. */
export function sampleDraft(plan: SamplePlan, who: { ownerName: string; child?: Base58; trusted?: readonly Base58[] }, words: DraftWords): WillDraft {
  return {
    ownerName: who.ownerName.trim().slice(0, 80) || "Parent",
    beneficiaries: [{ label: SAMPLE_CHILD, relationship: words.relationship, ...(who.child ? { wallet: who.child } : {}) }],
    verifiers: SAMPLE_TRUSTED.map((name, i) => ({ name, role: words.trustedRoles[i] ?? "", ...(who.trusted?.[i] ? { wallet: who.trusted[i] } : {}) })),
    rules: [{
      beneficiaryLabel: SAMPLE_CHILD, category: "Tuition", allowedPayeeKind: "University",
      maxPerClaimUsdt: plan.perClaim, lifetimeCapUsdt: plan.total, validUntil: SAMPLE_UNTIL, notes: words.notes.slice(0, 300), startsNow: true,
    }],
    assets: [],
    waitingPeriodDays: SAMPLE_WAITING_DAYS,
    plainLanguageSummary: fill(words.summary, { child: SAMPLE_CHILD.split(" ")[0], perClaim: plan.perClaim, total: plan.total, until: SAMPLE_UNTIL.slice(0, 4) }).slice(0, 2000),
  };
}

export interface GuidedDeps {
  service: HeirloomService;
  now(): number;
  ownerName: string;
  words: DraftWords;
  /** Devnet: a new wallet under the person's PIN. Demo: the demo story starts over with Thabo's wallet. */
  createOwner(): Promise<Base58>;
  /** Wallets for the child and the three trusted people, in that order. Devnet: practice wallets; demo: the demo family's. */
  createFamily(people: { label: string; role: "beneficiary" | "verifier" }[]): Promise<Base58[]>;
  /** Runs `work` signed by that wallet on this device (its own keys), whoever is signed in. */
  as<T>(address: Base58, work: () => Promise<T>): Promise<T>;
  evidence(): Promise<File>;
  /** The wallet's USD₮ in base units; null when it can't be read now. */
  balanceOf(address: Base58): Promise<bigint | null>;
}

export interface StepOutput { txs?: GuidedTx[]; note?: StepNote; patch?: Partial<Omit<GuidedState, "v" | "mode" | "steps">> }

const toBase = (usdt: number) => BigInt(Math.round(usdt * 1_000_000));
const txOf = (t: TxResult | null | undefined): GuidedTx[] => (t?.signature ? [{ signature: t.signature, explorerUrl: t.explorerUrl }] : []);

/** A failure in the words the screen needs: a program or service error's name, or a busy network. */
export function stepError(e: unknown): StepError {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  const given = (e as { code?: unknown } | null)?.code;
  if ((e as { name?: unknown } | null)?.name === "StarterError") {
    const retry = (e as { retryAfterSecs?: unknown }).retryAfterSecs;
    return { code: "starter", message, starterCode: typeof given === "string" ? given : "failed", ...(typeof retry === "number" ? { retryAfterSecs: retry } : {}) };
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return { code: "rateLimited", message };
  const named = PROGRAM_ERRORS.find((n) => new RegExp(`\\b${n}\\b`).test(message));
  // The program's own refusal wins over a transport code: the sponsor answers a failed simulation with
  // "simulation_failed" and the program's error name in the message (the over-cap step on devnet).
  if (named) return { code: named, message };
  if (typeof given === "string" && given && given !== "generic") return { code: given, message };
  const lead = /^([A-Za-z_]{3,40}):/.exec(message)?.[1];
  return { code: lead ?? "generic", message };
}

class GuidedError extends Error {
  constructor(public code: string, words: string) { super(`${code}: ${words}`); }
}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new GuidedError("generic", `${what} is missing. Start over.`);
  return v;
};

type Ctx = { s: GuidedState; d: GuidedDeps };

async function snapshot({ s, d }: Ctx): Promise<EstateSnapshot> {
  return d.as(need(s.owner, "The owner's wallet"), () => d.service.getEstate(need(s.estate, "The estate")));
}
async function theClaim(c: Ctx): Promise<Claim> {
  const snap = await snapshot(c);
  return need(snap.claims.find((x) => x.address === c.s.claim), "The claim");
}

const STEPS: Record<GuidedStepId, (c: Ctx) => Promise<StepOutput>> = {
  async wallet({ s, d }) {
    const owner = s.owner ?? await d.createOwner();
    return { patch: { owner }, note: { address: owner } };
  },

  async money({ s, d }) {
    const owner = need(s.owner, "The owner's wallet");
    const held = await d.balanceOf(owner);
    if (s.mode === "mock") return { note: { simulated: true, usdt: Number((held ?? 0n) / 1_000_000n) } };
    if (held !== null && held > 0n) return { note: { had: true, usdt: Number(held / 1_000_000n) } };
    try {
      const t = await d.as(owner, () => d.service.requestStarter());
      return { txs: txOf(t), note: { usdt: 500 } };
    } catch (e) {
      // Given once per wallet: a retry after the first one landed finds the money there.
      if ((e as { code?: unknown }).code === "already_funded") return { note: { had: true } };
      throw e;
    }
  },

  async plan({ s }) {
    const problem = checkPlan(s.plan, s.mode);
    if (problem) throw new GuidedError("plan", problem);
    return { note: { perClaim: s.plan.perClaim, total: s.plan.total } };
  },

  async people({ d }) {
    const made = await d.createFamily([
      { label: SAMPLE_CHILD, role: "beneficiary" },
      ...SAMPLE_TRUSTED.map((label) => ({ label, role: "verifier" as const })),
    ]);
    if (made.length !== 4 || new Set(made).size !== 4) throw new GuidedError("generic", "Four different wallets were not made.");
    return { patch: { child: made[0], trusted: made.slice(1) } };
  },

  async sign({ s, d }) {
    const owner = need(s.owner, "The owner's wallet");
    const draft = sampleDraft(s.plan, { ownerName: d.ownerName, child: s.child, trusted: s.trusted }, d.words);
    let txs: GuidedTx[] = [];
    let estate = s.estate;
    let topUpFailed = false;
    // Already signed (a retry after the signing landed): never a second plan. An unfinished one is finished.
    const listed = (await d.as(owner, () => d.service.listEstatesFor(owner))).find((e) => e.role === "owner");
    const unfinished = listed ? await d.as(owner, () => d.service.unfinishedSigning()) : null;
    if (!listed || unfinished) {
      const res = await d.as(owner, () => d.service.createEstateFromWill(draft, { practice: s.mode === "chain", residualLabel: SAMPLE_CHILD }));
      txs = res.txs.flatMap(txOf);
      estate = res.estate;
      topUpFailed = !!res.topUpFailed;
    } else {
      estate = listed.estate;
    }
    const snap = await d.as(owner, () => d.service.getEstate(need(estate, "The estate")));
    const rule = snap.rules.find((r) => r.beneficiary === s.child && r.category === "Tuition" && r.startsNow);
    const payee = snap.payees.find((p) => p.kind === "University");
    if (!rule || !payee) throw new GuidedError("generic", "The signed plan has no university rule or payee.");
    return { txs, patch: { estate, rule: rule.address, payee: payee.wallet }, note: { rules: snap.rules.length, payee: payee.name, ...(topUpFailed ? { topUpFailed } : {}) } };
  },

  async fund(c) {
    const { s, d } = c;
    const snap = await snapshot(c);
    if (snap.estate.vaultBalance >= toBase(s.plan.deposit)) return { note: { amount: s.plan.deposit, already: true } };
    const t = await d.as(need(s.owner, "The owner's wallet"), () => d.service.deposit(snap.estate.address, s.plan.deposit));
    return { txs: txOf(t), note: { amount: s.plan.deposit } };
  },

  async claim(c) {
    const { s, d } = c;
    const child = need(s.child, "The child's wallet");
    const mine = (snap: EstateSnapshot) => snap.claims.find((x) => x.beneficiary === child && x.rule === s.rule && x.amount === toBase(s.plan.claim) && x.status !== "Rejected");
    const before = mine(await snapshot(c));
    if (before) return { patch: { claim: before.address }, note: { amount: s.plan.claim } };
    const evidence = await d.evidence();
    try {
      const r = await d.as(child, () => d.service.submitClaim(need(s.estate, "The estate"), { rule: need(s.rule, "The rule"), payee: need(s.payee, "The payee"), amountUsdt: s.plan.claim, evidence }));
      return {
        txs: txOf(r.tx),
        patch: { claim: r.claim, ...(r.reviewTx?.signature ? { reviewTx: { signature: r.reviewTx.signature, explorerUrl: r.reviewTx.explorerUrl } } : {}) },
        note: { amount: s.plan.claim, file: evidence.name },
      };
    } catch (e) {
      // Sent, and the agent's review didn't finish: the claim stands, and the next step asks for the review again.
      if (stepError(e).code !== "ReviewPending") throw e;
      const sent = need(mine(await snapshot(c)), "The claim");
      return { patch: { claim: sent.address }, note: { amount: s.plan.claim, file: evidence.name } };
    }
  },

  async review(c) {
    const { s, d } = c;
    let claim = await theClaim(c);
    let txs: GuidedTx[] = s.reviewTx ? [s.reviewTx] : [];
    if (claim.agentVerdict === "Pending") {
      const evidence = await d.evidence();
      const r = await d.as(need(s.child, "The child's wallet"), () => d.service.requestReview(need(s.estate, "The estate"), { kind: "claim", subject: claim.address, evidence }));
      txs = txOf(r.tx);
      claim = await theClaim(c);
    }
    if (claim.agentVerdict === "Rejected") throw new GuidedError("agentRejected", claim.agentReport?.summary ?? "The agent turned the document down.");
    if (claim.agentVerdict === "Pending") throw new GuidedError("ReviewPending", "The agent's review hasn't finished yet.");
    return { txs, note: { verdict: claim.agentVerdict, ...(claim.agentReport?.summary ? { summary: claim.agentReport.summary.slice(0, 400) } : {}) } };
  },

  async approve(c) {
    const { s, d } = c;
    const claim = await theClaim(c);
    if (claim.ownerApproved || claim.status === "Paid") return { note: { already: true } };
    const t = await d.as(need(s.owner, "The owner's wallet"), () => d.service.ownerApproveClaim(need(s.estate, "The estate"), claim.address));
    return { txs: txOf(t) };
  },

  async pay(c) {
    const { s, d } = c;
    const claim = await theClaim(c);
    const snap = await snapshot(c);
    const payee = snap.payees.find((p) => p.wallet === claim.payee)?.name ?? "";
    if (claim.status === "Paid") return { note: { amount: s.plan.claim, payee, already: true } };
    const t = await d.as(need(s.owner, "The owner's wallet"), () => d.service.executeClaim(need(s.estate, "The estate"), claim.address));
    return { txs: txOf(t), note: { amount: s.plan.claim, payee } };
  },

  async cap({ s, d }) {
    const amount = overCapAmount(s.plan);
    const evidence = await d.evidence();
    try {
      await d.as(need(s.child, "The child's wallet"), () => d.service.submitClaim(need(s.estate, "The estate"), { rule: need(s.rule, "The rule"), payee: need(s.payee, "The payee"), amountUsdt: amount, evidence }));
    } catch (e) {
      const why = stepError(e);
      if (why.code === "ExceedsPerClaimCap" || why.code === "ExceedsLifetimeCap") return { note: { amount, refused: why.code } };
      throw e;
    }
    throw new GuidedError("notRefused", "A claim over the cap was accepted.");
  },
};

/** The work of step `id` on a state where it is running; throws on failure. */
export function performStep(s: GuidedState, id: GuidedStepId, d: GuidedDeps): Promise<StepOutput> {
  return STEPS[id]({ s, d });
}

/**
 * Runs the next step. `onRunning` gets the state with the step marked running (for the screen); the result is the
 * state with it done, or failed with the reason. Never throws.
 */
export async function runNext(s: GuidedState, d: GuidedDeps, onRunning?: (s: GuidedState) => void): Promise<GuidedState> {
  const id = nextStep(s);
  if (!id) return s;
  const running = startStep(s, id, d.now());
  onRunning?.(running);
  try {
    return finishStep(running, id, await performStep(running, id, d), d.now());
  } catch (e) {
    return failStep(running, id, stepError(e), d.now());
  }
}
