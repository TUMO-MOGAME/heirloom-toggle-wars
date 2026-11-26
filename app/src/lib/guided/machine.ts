/**
 * The guided run (plan §22.2): one tab walks a newcomer through the whole core story, from a new wallet to the program
 * refusing a claim over the cap. This file is the pure state machine: which step comes next, what each one recorded
 * (its transactions, a note for the screen, a failure in plain words) and the time it took. The work of each step is
 * in ./run.ts; the screen is components/guided.
 */
import type { Base58 } from "../types";

export const GUIDED_STEPS = ["wallet", "money", "plan", "people", "sign", "fund", "claim", "review", "approve", "pay", "cap"] as const;
export type GuidedStepId = (typeof GUIDED_STEPS)[number];
export type StepStatus = "todo" | "running" | "done" | "failed";

/** Steps that wait for the person's own tap: their wallet (a name and a PIN on devnet) and the plan they can edit. */
export const WAITS_FOR_TAP: readonly GuidedStepId[] = ["wallet", "plan"];

export interface GuidedTx { signature: string; explorerUrl: string }

export interface StepError {
  /** A program or service error name ("ExceedsPerClaimCap"), "rateLimited", "starter", "interrupted" or "generic". */
  code: string;
  /** The raw words, for the details line. The screen says it in plain words by `code`. */
  message: string;
  /** The starter's own refusal code ("hourly_cap"), when `code` is "starter". */
  starterCode?: string;
  retryAfterSecs?: number;
}

/** What a finished step tells the screen, beyond its transactions (verdicts, amounts, the refusal's name). */
export type StepNote = Record<string, string | number | boolean | undefined>;

export interface StepRecord {
  id: GuidedStepId;
  status: StepStatus;
  txs: GuidedTx[];
  startedAt?: number;
  endedAt?: number;
  error?: StepError;
  note?: StepNote;
}

/** The ready-made plan's numbers, which the person can change before signing (whole USD₮). */
export interface SamplePlan {
  /** The most one claim can pay. */
  perClaim: number;
  /** The most the rule pays in all. */
  total: number;
  /** What the owner puts into the vault. */
  deposit: number;
  /** What the child asks for first (within the cap). */
  claim: number;
}

export const DEFAULT_PLAN: SamplePlan = { perClaim: 50, total: 200, deposit: 120, claim: 40 };
/** The starter gives a new devnet wallet 500 test USD₮: the vault can't be funded with more. */
export const STARTER_USDT = 500;
/** The second claim asks for this much more than the per-claim cap, so the program must say no. */
export const OVER_CAP_BY = 10;
export const overCapAmount = (p: SamplePlan) => p.perClaim + OVER_CAP_BY;

export interface GuidedState {
  v: 1;
  mode: "mock" | "chain";
  startedAt: number | null;
  finishedAt: number | null;
  steps: StepRecord[];
  plan: SamplePlan;
  owner?: Base58;
  child?: Base58;
  trusted?: Base58[];
  estate?: Base58;
  rule?: Base58;
  payee?: Base58;
  claim?: Base58;
  /** The agent's review_claim, when it came back with the claim. */
  reviewTx?: GuidedTx;
}

export function initialState(mode: GuidedState["mode"], plan: SamplePlan = DEFAULT_PLAN): GuidedState {
  return { v: 1, mode, startedAt: null, finishedAt: null, plan: { ...plan }, steps: GUIDED_STEPS.map((id) => ({ id, status: "todo", txs: [] })) };
}

export const stepOf = (s: GuidedState, id: GuidedStepId): StepRecord => s.steps.find((x) => x.id === id)!;

/** The first step not done yet; null when the run is over. */
export function nextStep(s: GuidedState): GuidedStepId | null {
  return s.steps.find((x) => x.status !== "done")?.id ?? null;
}

export const isFinished = (s: GuidedState) => nextStep(s) === null;

const replace = (s: GuidedState, id: GuidedStepId, f: (r: StepRecord) => StepRecord): GuidedState => ({
  ...s, steps: s.steps.map((r) => (r.id === id ? f(r) : r)),
});

/** Steps run in order, one at a time: only the next step can start, and never while another is running. */
export function startStep(s: GuidedState, id: GuidedStepId, now: number): GuidedState {
  if (nextStep(s) !== id) throw new Error(`Step "${id}" is not next (next: ${nextStep(s) ?? "none"}).`);
  if (s.steps.some((r) => r.status === "running")) throw new Error("Another step is still running.");
  return replace({ ...s, startedAt: s.startedAt ?? now }, id, (r) => ({ ...r, status: "running", startedAt: now, endedAt: undefined, error: undefined }));
}

export function finishStep(
  s: GuidedState, id: GuidedStepId, out: { txs?: GuidedTx[]; note?: StepNote; patch?: Partial<Omit<GuidedState, "v" | "mode" | "steps">> }, now: number,
): GuidedState {
  if (stepOf(s, id).status !== "running") throw new Error(`Step "${id}" is not running.`);
  const next = replace({ ...s, ...out.patch }, id, (r) => ({ ...r, status: "done", endedAt: now, txs: [...r.txs, ...(out.txs ?? [])], note: out.note, error: undefined }));
  return isFinished(next) ? { ...next, finishedAt: now } : next;
}

export function failStep(s: GuidedState, id: GuidedStepId, error: StepError, now: number): GuidedState {
  if (stepOf(s, id).status !== "running") throw new Error(`Step "${id}" is not running.`);
  return replace(s, id, (r) => ({ ...r, status: "failed", endedAt: now, error }));
}

/** After a reload: a step that was running didn't finish in this tab. It is offered again (each step checks first). */
export function interrupted(s: GuidedState, now: number): GuidedState {
  const running = s.steps.find((r) => r.status === "running");
  return running ? failStep(s, running.id, { code: "interrupted", message: "The page was closed or reloaded during this step." }, now) : s;
}

/** The plan's numbers can change only before it is signed. */
export function setPlan(s: GuidedState, plan: SamplePlan): GuidedState {
  if (stepOf(s, "plan").status === "done") throw new Error("The plan is already signed.");
  return { ...s, plan: { ...plan } };
}

export function progress(s: GuidedState): { done: number; total: number } {
  return { done: s.steps.filter((r) => r.status === "done").length, total: s.steps.length };
}

/** Time since the first step started, up to the last one's end. */
export function elapsedMs(s: GuidedState, now: number): number {
  if (s.startedAt === null) return 0;
  return Math.max(0, (s.finishedAt ?? now) - s.startedAt);
}

export const stepMs = (r: StepRecord, now: number) => (r.startedAt === undefined ? 0 : Math.max(0, (r.endedAt ?? now) - r.startedAt));

/** "1:05", "12:30", "1:02:03". */
export function clockText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export type PlanProblem = "whole" | "perClaimOverTotal" | "claimOverCap" | "depositBelowClaim" | "depositOverStarter";

/** What would stop the ready-made plan from telling the story: checked before anything is signed. */
export function checkPlan(p: SamplePlan, mode: GuidedState["mode"]): PlanProblem | null {
  const whole = (n: number) => Number.isInteger(n) && n > 0 && n <= 10_000;
  if (![p.perClaim, p.total, p.deposit, p.claim].every(whole)) return "whole";
  if (p.perClaim > p.total) return "perClaimOverTotal";
  if (p.claim > p.perClaim) return "claimOverCap";
  if (p.deposit < p.claim) return "depositBelowClaim";
  if (mode === "chain" && p.deposit > STARTER_USDT) return "depositOverStarter";
  return null;
}

/* ---------- this device ---------- */

export const storeKey = (mode: GuidedState["mode"]) => `heirloom.guided.v1.${mode}`;

/** A saved run, or null when it is missing, broken or from the other kind of site. Never holds a PIN or a seed. */
export function parseState(raw: string | null, mode: GuidedState["mode"]): GuidedState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as GuidedState;
    if (s?.v !== 1 || s.mode !== mode || !Array.isArray(s.steps) || s.steps.length !== GUIDED_STEPS.length) return null;
    if (!s.steps.every((r, i) => r.id === GUIDED_STEPS[i] && ["todo", "running", "done", "failed"].includes(r.status) && Array.isArray(r.txs))) return null;
    if (checkPlan(s.plan, mode) === "whole") return null;
    return s;
  } catch {
    return null;
  }
}
