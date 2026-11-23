/**
 * Letters as the estate sees them (plan.md §16.5): the rule contexts built from an estate snapshot, a letter's view
 * (state and the hint the UI shows), and what one viewer may see. Shared by the mock service and the server route,
 * so the demo and devnet answer the same way.
 */
import type { Base58 } from "../types";
import type { EstateSnapshot } from "../service/types";
import { fromBase } from "../format";
import { shortName } from "../names";
import { canRead, letterState, opensAt, visibleCounts, type CheckCtx, type ReadCtx } from "./rules";
import type { ReviewCtx } from "./review";
import type { Letter, LetterHint, LetterInput, LetterView, LettersView } from "./types";

export const activeBeneficiaries = (snap: EstateSnapshot) => snap.beneficiaries.filter((b) => b.active).map((b) => b.wallet);

/** The opening and reading context of an estate at `nowMs`. */
export function readCtx(snap: EstateSnapshot, nowMs: number, sendConfirmed: (sig: string) => boolean = () => false): ReadCtx {
  return {
    status: snap.estate.status, nowMs, sendConfirmed, activeBeneficiaries: activeBeneficiaries(snap),
    ruleSpent: (rule) => snap.rules.find((r) => r.address === rule)?.spentTotal ?? null,
    ruleGeneration: (rule) => (snap.rules.find((r) => r.address === rule)?.claimCount ?? 0) >>> 16,
  };
}

export function checkCtx(snap: EstateSnapshot, nowMs: number, canTranscribe: (person: string) => boolean): CheckCtx {
  return {
    nowMs, activeBeneficiaries: activeBeneficiaries(snap), canTranscribe,
    rules: snap.rules.map((r) => ({ address: r.address, beneficiary: r.beneficiary })),
    assets: snap.assets.map((a) => a.address),
  };
}

/**
 * The rule's payment in USD₮: a schedule's fixed amount. A claim rule has no set payment (its per-claim limit is a
 * ceiling, not what will be paid), so it has none until a claim is paid.
 */
export function giftOf(snap: EstateSnapshot, rule: Base58): number | undefined {
  const r = snap.rules.find((x) => x.address === rule);
  if (!r || r.recurringAmount <= BigInt(0)) return undefined;
  return fromBase(r.recurringAmount);
}

function hintFor(l: Letter, snap: EstateSnapshot): LetterHint {
  const o = l.opens;
  if (o.kind === "date") { const t = opensAt(o.on); return Number.isFinite(t) ? { on: Math.floor(t / 1000) } : {}; }
  if (o.kind !== "payment") return {};
  const r = snap.rules.find((x) => x.address === o.rule);
  if (!r) return {};
  // The payment that opened it: the first vault payment under the rule after the letter was linked.
  const paid = snap.activity
    .filter((a) => a.payment?.rule === o.rule && (a.kind === "ScheduledPaid" || a.kind === "ClaimPaid") && a.ts >= l.createdAt - 5)
    .sort((a, b) => a.ts - b.ts)[0];
  // A claim payout that opened it gives the amount actually paid.
  const paidClaim = paid?.payment?.claim ? snap.claims.find((c) => c.address === paid.payment!.claim) : undefined;
  const gift = giftOf(snap, o.rule) ?? (paidClaim ? fromBase(paidClaim.amount) : undefined);
  return {
    ...(r.nextDue ? { on: r.nextDue } : {}), ...(gift !== undefined ? { giftUsdt: gift } : {}), ruleLabel: r.category,
    ...(paid?.txSignature ? { paidSig: paid.txSignature, paidAt: paid.ts } : {}),
  };
}

/**
 * A letter's view. A letter that is open but was never marked (a seeded letter, or one the server has not seen open
 * yet) shows when it opened: its date, the payment that opened it, or now.
 */
export function viewOf(l: Letter, snap: EstateSnapshot, ctx: ReadCtx): LetterView {
  const state = letterState(l, ctx);
  const hint = hintFor(l, snap);
  const openedAt = l.openedAt ?? (state === "open"
    ? (l.opens.kind === "date" ? hint.on : l.opens.kind === "payment" ? hint.paidAt : undefined) ?? Math.floor(ctx.nowMs / 1000)
    : null);
  return { ...l, openedAt, state, hint };
}

/** The review's view of the plan for a draft: the recipient, the assets and where they go, a gift's amount. */
export function reviewCtxFor(snap: EstateSnapshot, draft: Pick<LetterInput, "to" | "opens" | "about">, usdtZar: number): ReviewCtx {
  const to = draft.to.kind === "family" ? "family" : draft.to.wallet;
  const label = to === "family" ? "family" : snap.beneficiaries.find((b) => b.wallet === to)?.label ?? snap.names?.[to] ?? "";
  return {
    estate: snap.estate.address, recipient: to, recipientName: label === "family" ? "family" : shortName(label.replace(/\s*\(.*\)$/, "")),
    assets: snap.assets.filter((a) => a.status !== "Sold").map((a) => ({ address: a.address, title: a.title, proceedsTo: a.proceedsTo })),
    ...(draft.about ? { about: draft.about.asset } : {}),
    ...(draft.opens.kind === "payment" ? { giftUsdt: giftOf(snap, draft.opens.rule) } : {}),
    usdtZar,
  };
}

/** The plan in a few plain lines, for the AI reviewer (trusted context; amounts in USD₮, no personal data). */
export function planFacts(snap: EstateSnapshot): string {
  const who = (w: Base58) => snap.beneficiaries.find((b) => b.wallet === w)?.label ?? "someone";
  const rules = snap.rules.map((r) => `- ${who(r.beneficiary)}: ${r.category}${r.recurringAmount > BigInt(0) ? `, ${fromBase(r.recurringAmount)} USD₮ a payment` : `, up to ${fromBase(r.maxPerClaim)} USD₮ a claim`}${r.startsNow ? ", starts now" : ", after the passing"}`);
  const assets = snap.assets.map((a) => `- ${a.title}: ${a.proceedsTo === snap.estate.address ? "sold; the money goes into the family vault" : `goes to ${who(a.proceedsTo)}`}`);
  return [`Family members: ${snap.beneficiaries.filter((b) => b.active).map((b) => b.label).join(", ")}`, "Rules:", ...rules, "Assets:", ...assets].join("\n");
}

/** A tombstone as the owner sees it: no text, no occasion, no about. */
export const tomb = (l: Letter): Letter => {
  const t: Letter = { ...l, text: "", occasion: "", deleted: true };
  delete t.about;
  delete t.transcribed;
  return t;
};

/**
 * What `viewer` sees: the owner all their letters (tombstones without text); a beneficiary the open letters they may
 * read; everyone in the family the counts. Null when the viewer has no role here (the route answers 403).
 */
export function lettersFor(all: Letter[], snap: EstateSnapshot, viewer: Base58 | null, nowMs: number, sendConfirmed?: (sig: string) => boolean): LettersView | null {
  const ctx = readCtx(snap, nowMs, sendConfirmed);
  const st = snap.estate.status;
  const base = { counts: visibleCounts(all, ctx), sealed: st === "Unlocked" || st === "Frozen", paused: st === "DeathPending" };
  if (viewer && viewer === snap.estate.owner) {
    return { ...base, letters: all.filter((l) => l.from === viewer).map((l) => viewOf(l.deleted ? tomb(l) : l, snap, ctx)) };
  }
  if (!viewer || !ctx.activeBeneficiaries.includes(viewer)) return null;
  return { ...base, letters: all.filter((l) => !l.deleted && canRead(l, viewer, ctx)).map((l) => viewOf(l, snap, ctx)) };
}
