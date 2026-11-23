/**
 * Trust Tree inputs (plan.md §15): estate history as plain, value-free facts.
 *
 * Both modes feed the same rules (promises.ts) and derive (derive.ts) with `TreeEvent`s:
 *  - chain: decoded program events (`treeEventsFromChain`, the estate's full history from lib/chain/reads);
 *  - mock and any gap in chain history: facts read off an EstateSnapshot (`snapshotFacts`: roles, rules, claims,
 *    approvals, payments, guardians, disputes, assets), plus the demo story's imagined events.
 * A TreeEvent never carries an amount, price or balance: only wallets, ids, kinds and times.
 */
import type { Base58, Category } from "../types";
import type { AssetKind, TargetKind } from "../guardians/types";
import type { EstateSnapshot } from "../service/types";
import type { Raw } from "../chain/decoders";
import { isCurrentClaim, unlockWaitSecs } from "../death-rules";

interface Base {
  estate: Base58;
  /** Unix seconds. */
  ts: number;
  /** Transaction signature (chain) or a simulated id (mock); empty when only known from an account. */
  sig: string;
  /** The demo story's future (always false on chain). */
  imagined?: boolean;
}

export type TreeEvent = Base & (
  | { kind: "EstateCreated"; owner: Base58 }
  /** The estate's three trusted people, as recorded on the Estate account. */
  | { kind: "VerifiersSet"; verifiers: Base58[] }
  | { kind: "BeneficiaryAdded"; wallet: Base58 }
  | { kind: "RuleSet"; rule: Base58; category: Category; beneficiary: Base58 }
  | { kind: "DeathClaimSubmitted"; by: Base58 }
  | { kind: "DeathAttested"; verifier: Base58 }
  | { kind: "DeathVetoed" }
  | { kind: "EstateUnlocked" }
  | { kind: "ClaimSubmitted"; claim: Base58; rule: Base58; beneficiary: Base58 }
  | { kind: "ClaimApproved"; claim: Base58; verifier: Base58 }
  | { kind: "ClaimOwnerApproved"; claim: Base58; owner: Base58 }
  | { kind: "ClaimPaid"; claim: Base58; rule: Base58 }
  | { kind: "ScheduledPaid"; rule: Base58 }
  | { kind: "HardshipSubmitted"; hardship: Base58; asset: Base58; beneficiary: Base58 }
  | { kind: "HardshipApproved"; hardship: Base58; verifier: Base58; quorum: boolean }
  | { kind: "SeatConfigured"; seat: number; holder: Base58 | null; backups: Base58[]; monitors: Base58[] }
  | { kind: "SeatApproval"; seat: number; approver: Base58; target: Base58; targetKind: TargetKind }
  | { kind: "SeatDeathReported"; seat: number; holder: Base58 }
  | { kind: "SeatDeathConfirmed"; seat: number; by: Base58 }
  | { kind: "SeatDeathVetoed"; seat: number }
  | { kind: "SuccessionFinalized"; seat: number; previous: Base58; next: Base58 }
  | { kind: "SeatVacated"; seat: number; previous: Base58 }
  | { kind: "FallbackSet"; recipients: Base58[] }
  | { kind: "FallbackExecuted"; recipient: Base58 }
  | { kind: "DisputeRaised"; dispute: Base58; target: Base58; targetKind: TargetKind; by: Base58 }
  | { kind: "DisputeResolved"; dispute: Base58; target: Base58; targetKind: TargetKind; upheld: boolean }
  | { kind: "ObjectionRaised"; objection: Base58; target: Base58; targetKind: TargetKind; by: Base58 }
  | { kind: "ObjectionResolved"; objection: Base58; target: Base58; targetKind: TargetKind; upheld: boolean }
  | { kind: "AssetRegistered"; asset: Base58; title: string; assetKind: AssetKind }
  | { kind: "AssetSold"; asset: Base58; recipient: Base58 | null; hardship: boolean }
  /** Off-chain (demo story): the asset itself went to an heir under the plan. */
  | { kind: "AssetPassed"; asset: Base58; to: Base58 }
);

export type TreeEventKind = TreeEvent["kind"];

/** The system program's all-ones key, used on-chain for an empty seat / fallback slot. */
export const EMPTY_KEY = "11111111111111111111111111111111";
const real = (w: Base58 | null | undefined): w is Base58 => !!w && w !== EMPTY_KEY;

/** One identity per fact, so history and snapshot facts can be merged without counting anything twice. */
export function eventKey(e: TreeEvent): string {
  switch (e.kind) {
    case "EstateCreated": case "VerifiersSet": case "EstateUnlocked": return `${e.kind}:${e.estate}`;
    case "BeneficiaryAdded": return `${e.kind}:${e.estate}:${e.wallet}`;
    case "RuleSet": return `${e.kind}:${e.rule}`;
    case "DeathClaimSubmitted": case "DeathVetoed": return `${e.kind}:${e.estate}:${e.ts}`;
    case "DeathAttested": return `${e.kind}:${e.estate}:${e.verifier}`;
    case "ClaimSubmitted": return `${e.kind}:${e.claim}`;
    case "ClaimApproved": return `${e.kind}:${e.claim}:${e.verifier}`;
    case "ClaimOwnerApproved": return `${e.kind}:${e.claim}`;
    case "ClaimPaid": return `${e.kind}:${e.claim}`;
    // The slot, not which of its rules: an activity line knows only the address, the history knows the earlier rule.
    case "ScheduledPaid": return `${e.kind}:${e.rule.split("#")[0]}:${e.sig || e.ts}`;
    case "HardshipSubmitted": return `${e.kind}:${e.hardship}`;
    case "HardshipApproved": return `${e.kind}:${e.hardship}:${e.verifier}`;
    case "SeatConfigured": return `${e.kind}:${e.estate}:${e.seat}:${e.holder ?? ""}`;
    case "SeatApproval": return `${e.kind}:${e.target}:${e.approver}`;
    case "SeatDeathReported": case "SeatDeathConfirmed": case "SeatDeathVetoed": return `${e.kind}:${e.estate}:${e.seat}:${e.sig || e.ts}`;
    case "SuccessionFinalized": return `${e.kind}:${e.estate}:${e.seat}:${e.next}`;
    case "SeatVacated": return `${e.kind}:${e.estate}:${e.seat}:${e.previous}`;
    case "FallbackSet": return `${e.kind}:${e.estate}`;
    case "FallbackExecuted": return `${e.kind}:${e.estate}`;
    case "DisputeRaised": case "DisputeResolved": return `${e.kind}:${e.dispute}`;
    case "ObjectionRaised": case "ObjectionResolved": return `${e.kind}:${e.objection}`;
    case "AssetRegistered": return `${e.kind}:${e.asset}`;
    case "AssetSold": return `${e.kind}:${e.asset}`;
    case "AssetPassed": return `${e.kind}:${e.asset}:${e.to}`;
  }
}

/**
 * Merges lists of facts, oldest first. A fact in a later list is dropped when an earlier list already has the same
 * fact (`eventKey`), so pass the chain history first and snapshot facts after it. Within one list nothing is dropped
 * (a trusted person may confirm a passing again after a veto, a seat may be configured twice).
 */
export function mergeEvents(...lists: TreeEvent[][]): TreeEvent[] {
  const seen = new Set<string>();
  const out: TreeEvent[] = [];
  for (const list of lists) {
    const mine = list.map(eventKey);
    list.forEach((e, i) => { if (!seen.has(mine[i])) out.push(e); });
    for (const k of mine) seen.add(k);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The id of a rule that held a slot before it was reused (its claims' high 16 bits number it). Not an address. */
const earlierRule = (rule: Base58, generation: number): string => `${rule}#${generation}`;

/* ---------- from decoded program events (chain) ---------- */

/** A decoded program event (lib/chain/reads ChainEvent). Declared here so tests need no RPC. */
export interface RawChainEvent { name: string; data: Raw; ts: number; signature: string }

function field(d: Raw, name: string): unknown {
  const want = name.replace(/_/g, "").toLowerCase();
  for (const k of Object.keys(d)) if (k.replace(/_/g, "").toLowerCase() === want) return d[k];
  return undefined;
}
function pk(d: Raw, name: string): Base58 | null {
  const v = field(d, name);
  if (v && typeof (v as { toBase58?: () => string }).toBase58 === "function") return (v as { toBase58: () => string }).toBase58();
  return typeof v === "string" && v ? v : null;
}
function int(d: Raw, name: string): number {
  const v = field(d, name);
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof (v as { toString(): string }).toString === "function") { const n = Number(String(v)); return Number.isFinite(n) ? n : 0; }
  return 0;
}
const flag = (d: Raw, name: string) => Boolean(field(d, name));
function keys(d: Raw, name: string): Base58[] {
  const v = field(d, name);
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x && typeof (x as { toBase58?: () => string }).toBase58 === "function" ? (x as { toBase58: () => string }).toBase58() : typeof x === "string" ? x : ""))
    .filter(real);
}
const TARGET_KINDS: TargetKind[] = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"];
function targetKind(d: Raw): TargetKind {
  const v = field(d, "kind");
  const variant = typeof v === "string" ? v : v && typeof v === "object" ? Object.keys(v)[0] : "";
  return TARGET_KINDS.find((k) => k.toLowerCase() === String(variant).toLowerCase()) ?? "Claim";
}
const ASSET_KINDS: AssetKind[] = ["Car", "Motorbike", "Furniture", "Jewellery", "Electronics", "Other"];
function assetKindOf(d: Raw): AssetKind | null {
  const v = field(d, "kind");
  const variant = typeof v === "string" ? v : v && typeof v === "object" ? Object.keys(v)[0] : "";
  return ASSET_KINDS.find((k) => k.toLowerCase() === String(variant).toLowerCase()) ?? null;
}

/** A value-free kind from an asset's title ("2017 Toyota Corolla" → Car). The registered media kind wins when known. */
export function assetKindFromTitle(title: string): AssetKind {
  const t = title.toLowerCase();
  if (/motor\s?bike|motorcycle|scooter|mustang 250|big boy|honda cb|yamaha|ktm|ducati|harley/.test(t)) return "Motorbike";
  if (/car|toyota|corolla|vw|volkswagen|polo|bmw|mercedes|ford|nissan|hyundai|kia|mazda|audi|bakkie|suv|sedan|hatch/.test(t)) return "Car";
  if (/ring|necklace|watch|jewel|gold|bracelet/.test(t)) return "Jewellery";
  if (/sofa|table|chair|bed|cabinet|furniture|wardrobe/.test(t)) return "Furniture";
  if (/laptop|tv|television|phone|computer|camera|console/.test(t)) return "Electronics";
  return "Other";
}

export interface ChainDecodeContext {
  estate: Base58;
  /** Asset titles by asset address and kinds by asset (off-chain names; never values). */
  assetTitles?: Record<Base58, string>;
  assetKinds?: Record<Base58, AssetKind>;
}

/**
 * The tree's facts from the estate's program events. Unknown or value-only events (deposits, offers, listings, caps,
 * reviews) are dropped; amounts in the events are never read.
 */
export function treeEventsFromChain(events: RawChainEvent[], ctx: ChainDecodeContext): TreeEvent[] {
  const out: TreeEvent[] = [];
  const mediaKinds: Record<Base58, AssetKind> = {};
  for (const ev of events) if (ev.name.toLowerCase() === "assetmediaset") {
    const a = pk(ev.data, "asset"); const k = assetKindOf(ev.data);
    if (a && k) mediaKinds[a] = k;
  }
  // A title the owner took back is no longer in the plan: only a registration after that still stands.
  const released = new Map<Base58, number>();
  // A reused rule slot keeps its address: what happened under the rule before it must not be read as the new rule's.
  const reused: { rule: Base58; ts: number; generation: number }[] = [];
  for (const ev of events) {
    const n = ev.name.toLowerCase();
    if (n === "assetreleased") { const a = pk(ev.data, "asset"); if (a) released.set(a, Math.max(ev.ts, released.get(a) ?? 0)); }
    else if (n === "rulereused") { const rule = pk(ev.data, "rule"); if (rule) reused.push({ rule, ts: ev.ts, generation: int(ev.data, "first_claim_id") >>> 16 }); }
  }
  const ruleAt = (rule: Base58, ts: number): Base58 => {
    const next = reused.filter((r) => r.rule === rule && ts < r.ts).sort((a, b) => a.ts - b.ts)[0];
    return next ? earlierRule(rule, next.generation - 1) : rule;
  };
  for (const ev of events) {
    const d = ev.data;
    const b = { estate: ctx.estate, ts: ev.ts, sig: ev.signature };
    const n = ev.name.charAt(0).toUpperCase() + ev.name.slice(1);
    const push = (e: TreeEvent) => out.push(e);
    switch (n) {
      case "EstateCreated": { const owner = pk(d, "owner"); if (owner) push({ ...b, kind: n, owner }); break; }
      case "DeathClaimSubmitted": { const by = pk(d, "submitted_by"); if (by) push({ ...b, kind: n, by }); break; }
      case "DeathAttested": { const v = pk(d, "verifier"); if (v) push({ ...b, kind: n, verifier: v }); break; }
      case "DeathVetoed": push({ ...b, kind: n }); break;
      case "EstateUnlocked": push({ ...b, kind: n }); break;
      case "ClaimSubmitted": {
        const claim = pk(d, "claim"), rule = pk(d, "rule"), beneficiary = pk(d, "beneficiary");
        if (claim && rule && beneficiary) push({ ...b, kind: n, claim, rule: ruleAt(rule, ev.ts), beneficiary });
        break;
      }
      case "ClaimApproved": { const claim = pk(d, "claim"), v = pk(d, "verifier"); if (claim && v) push({ ...b, kind: n, claim, verifier: v }); break; }
      case "ClaimOwnerApproved": { const claim = pk(d, "claim"), owner = pk(d, "owner"); if (claim && owner) push({ ...b, kind: n, claim, owner }); break; }
      case "ClaimPaid": { const claim = pk(d, "claim"), rule = pk(d, "rule"); if (claim && rule) push({ ...b, kind: n, claim, rule: ruleAt(rule, ev.ts) }); break; }
      case "ScheduledPaid": { const rule = pk(d, "rule"); if (rule) push({ ...b, kind: n, rule: ruleAt(rule, ev.ts) }); break; }
      case "HardshipSubmitted": {
        const hardship = pk(d, "hardship"), asset = pk(d, "asset"), beneficiary = pk(d, "beneficiary");
        if (hardship && asset && beneficiary) push({ ...b, kind: n, hardship, asset, beneficiary });
        break;
      }
      case "HardshipApproved": {
        const hardship = pk(d, "hardship"), v = pk(d, "verifier");
        if (hardship && v) push({ ...b, kind: n, hardship, verifier: v, quorum: flag(d, "quorum_reached") });
        break;
      }
      case "SeatConfigured": {
        const holder = pk(d, "holder");
        push({ ...b, kind: n, seat: int(d, "seat_index"), holder: real(holder) ? holder : null, backups: keys(d, "backups"), monitors: keys(d, "monitors") });
        break;
      }
      case "SeatApproval": {
        const approver = pk(d, "approver"), target = pk(d, "target");
        if (approver && target) push({ ...b, kind: n, seat: int(d, "seat_index"), approver, target, targetKind: targetKind(d) });
        break;
      }
      case "SeatDeathReported": { const holder = pk(d, "holder"); if (holder) push({ ...b, kind: n, seat: int(d, "seat_index"), holder }); break; }
      case "SeatDeathConfirmed": { const by = pk(d, "confirmed_by"); if (by) push({ ...b, kind: n, seat: int(d, "seat_index"), by }); break; }
      case "SeatDeathVetoed": push({ ...b, kind: n, seat: int(d, "seat_index") }); break;
      // Cleared for a fresh report: like a veto, nobody is credited and nobody has passed.
      case "SeatDeathReportCleared": push({ ...b, kind: "SeatDeathVetoed", seat: int(d, "seat_index") }); break;
      case "SuccessionFinalized": {
        const previous = pk(d, "previous_holder"), next = pk(d, "new_holder");
        if (previous && next) push({ ...b, kind: n, seat: int(d, "seat_index"), previous, next });
        break;
      }
      case "SeatVacated": { const previous = pk(d, "previous_holder"); if (previous) push({ ...b, kind: n, seat: int(d, "seat_index"), previous }); break; }
      case "FallbackSet": push({ ...b, kind: n, recipients: keys(d, "recipients") }); break;
      case "FallbackExecuted": { const r = pk(d, "recipient"); if (r) push({ ...b, kind: n, recipient: r }); break; }
      case "DisputeRaised": {
        const dispute = pk(d, "objection"), target = pk(d, "target"), by = pk(d, "disputer");
        if (dispute && target && by) push({ ...b, kind: n, dispute, target, targetKind: targetKind(d), by });
        break;
      }
      case "DisputeResolved": {
        const dispute = pk(d, "objection"), target = pk(d, "target");
        if (dispute && target) push({ ...b, kind: n, dispute, target, targetKind: targetKind(d), upheld: flag(d, "upheld") });
        break;
      }
      case "ObjectionRaised": {
        const objection = pk(d, "objection"), target = pk(d, "target"), by = pk(d, "monitor");
        if (objection && target && by) push({ ...b, kind: n, objection, target, targetKind: targetKind(d), by });
        break;
      }
      case "ObjectionResolved": {
        const objection = pk(d, "objection"), target = pk(d, "target");
        if (objection && target) push({ ...b, kind: n, objection, target, targetKind: targetKind(d), upheld: flag(d, "upheld") });
        break;
      }
      case "AssetRegistered": {
        const asset = pk(d, "asset");
        if (!asset || ev.ts < (released.get(asset) ?? -Infinity)) break;
        const title = ctx.assetTitles?.[asset] ?? "";
        push({ ...b, kind: n, asset, title, assetKind: ctx.assetKinds?.[asset] ?? mediaKinds[asset] ?? assetKindFromTitle(title) });
        break;
      }
      case "AssetSold": {
        const asset = pk(d, "asset");
        if (asset) push({ ...b, kind: n, asset, recipient: pk(d, "recipient"), hardship: flag(d, "hardship") });
        break;
      }
      default: break; // deposits, offers, listings, reviews, caps: nothing for the tree
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* ---------- from an estate snapshot (mock, and gaps in chain history) ---------- */

/**
 * Facts an EstateSnapshot holds about its people: roles, rules, claims (with who approved), payments (from the
 * activity lines' payment refs), the passing, guardians, upheld disputes and objections, assets. Times come from the
 * matching activity line when there is one, else from the account (a claim's createdAt), else the estate's creation.
 * `history` (decoded chain events) is consulted only to time the roles; merge with `mergeEvents(history, facts)`.
 */
export function snapshotFacts(snap: EstateSnapshot, history: TreeEvent[] = [], opts: { imagined?: boolean; assetKinds?: Record<Base58, AssetKind> } = {}): TreeEvent[] {
  const e = snap.estate;
  const estate = e.address;
  const act = [...snap.activity].sort((a, b) => a.ts - b.ts);
  const firstAct = (kind: string) => act.find((a) => a.kind === kind);
  const created = history.find((h) => h.kind === "EstateCreated")?.ts
    ?? firstAct("EstateCreated")?.ts ?? history[0]?.ts ?? act[0]?.ts ?? e.lastHeartbeat ?? 0;
  const im = opts.imagined ? { imagined: true } : {};
  const b = (ts: number, sig = "") => ({ estate, ts, sig, ...im });
  const out: TreeEvent[] = [];

  out.push({ ...b(created, firstAct("EstateCreated")?.txSignature ?? ""), kind: "EstateCreated", owner: e.owner });
  const verifiers = e.verifiers.filter(real);
  if (verifiers.length) out.push({ ...b(created), kind: "VerifiersSet", verifiers });
  for (const ben of snap.beneficiaries) if (ben.active) out.push({ ...b(created), kind: "BeneficiaryAdded", wallet: ben.wallet });
  for (const r of snap.rules) out.push({ ...b(created), kind: "RuleSet", rule: r.address, category: r.category, beneficiary: r.beneficiary });

  // Claims: who asked, who approved (the approvals bitmap; times approximated by the claim's creation).
  const ruleOf = (c: EstateSnapshot["claims"][number]) => {
    const count = snap.rules.find((r) => r.address === c.rule)?.claimCount;
    return count === undefined || isCurrentClaim(c.id, count) ? c.rule : earlierRule(c.rule, c.id >>> 16);
  };
  for (const c of snap.claims) {
    out.push({ ...b(c.createdAt), kind: "ClaimSubmitted", claim: c.address, rule: ruleOf(c), beneficiary: c.beneficiary });
    c.approvals.forEach((ok, i) => { if (ok && real(e.verifiers[i])) out.push({ ...b(c.createdAt), kind: "ClaimApproved", claim: c.address, verifier: e.verifiers[i] }); });
    if (c.ownerApproved) out.push({ ...b(c.createdAt), kind: "ClaimOwnerApproved", claim: c.address, owner: e.owner });
  }
  // Payments out of the vault, from the activity lines (the payment ref names the rule and the claim; the amount is ignored).
  for (const a of act) {
    if (a.kind === "ClaimPaid" && a.payment?.claim && a.payment.rule) out.push({ ...b(a.ts, a.txSignature ?? ""), kind: "ClaimPaid", claim: a.payment.claim, rule: a.payment.rule });
    else if (a.kind === "ScheduledPaid" && a.payment?.rule) out.push({ ...b(a.ts, a.txSignature ?? ""), kind: "ScheduledPaid", rule: a.payment.rule });
    else if (a.kind === "FallbackExecuted" && a.payment?.payee) out.push({ ...b(a.ts, a.txSignature ?? ""), kind: "FallbackExecuted", recipient: a.payment.payee });
  }
  // A paid claim the activity lines don't show (older than the feed): its own record of payment.
  for (const c of snap.claims) {
    if (c.status === "Paid" && !out.some((x) => x.kind === "ClaimPaid" && x.claim === c.address)) out.push({ ...b(c.createdAt, c.txSignature ?? ""), kind: "ClaimPaid", claim: c.address, rule: ruleOf(c) });
  }

  // The owner's passing: who confirmed it (it counts on the tree only once the estate unlocked, promises.ts).
  if (e.status === "Unlocked" || e.status === "DeathPending") {
    const unlocked = firstAct("EstateUnlocked");
    const attested = act.filter((a) => a.kind === "DeathAttested");
    const at = unlocked?.ts ?? (e.death.pendingSince ?? created) + unlockWaitSecs(e);
    const attestedAt = e.death.pendingSince ?? attested[attested.length - 1]?.ts ?? at;
    if (e.death.submittedBy) out.push({ ...b(firstAct("DeathClaimSubmitted")?.ts ?? attestedAt), kind: "DeathClaimSubmitted", by: e.death.submittedBy });
    e.death.attestations.forEach((ok, i) => { if (ok && real(e.verifiers[i])) out.push({ ...b(attestedAt), kind: "DeathAttested", verifier: e.verifiers[i] }); });
    if (e.status === "Unlocked") out.push({ ...b(at, unlocked?.txSignature ?? ""), kind: "EstateUnlocked" });
  }

  // Hardship requests: who asked, who approved.
  for (const h of snap.hardships) {
    out.push({ ...b(created), kind: "HardshipSubmitted", hardship: h.address, asset: h.asset, beneficiary: h.beneficiary });
    h.approvals.forEach((ok, i) => { if (ok && real(e.verifiers[i])) out.push({ ...b(created), kind: "HardshipApproved", hardship: h.address, verifier: e.verifiers[i], quorum: h.status === "Approved" }); });
  }

  // Guardians: seats (holder, backups, monitors), seat approvals, the fallback order, upheld objections.
  const g = snap.guardians;
  if (g?.enabled) {
    const at = firstAct("GuardInitialized")?.ts ?? created;
    for (const s of g.seats) out.push({ ...b(at), kind: "SeatConfigured", seat: s.index, holder: s.holder, backups: s.backups.map((x) => x.wallet).filter(real), monitors: s.monitors.map((x) => x.wallet).filter(real) });
    for (const f of g.feed) out.push({ ...b(f.ts, f.txSignature ?? ""), kind: "SeatApproval", seat: f.seatIndex, approver: f.approver, target: f.target, targetKind: f.kind });
    const rec = g.fallback.recipients.map((r) => r.wallet).filter(real);
    if (rec.length) out.push({ ...b(at), kind: "FallbackSet", recipients: rec });
    for (const o of g.objections) {
      out.push({ ...b(o.raisedAt), kind: "ObjectionRaised", objection: o.address, target: o.target, targetKind: o.kind, by: o.monitor });
      if (o.status !== "Open") out.push({ ...b(o.raisedAt), kind: "ObjectionResolved", objection: o.address, target: o.target, targetKind: o.kind, upheld: o.status === "Upheld" });
    }
  }
  for (const d of snap.disputes ?? []) {
    const kind: TargetKind = d.kind === "Unlock" ? "Unlock" : "Claim";
    out.push({ ...b(d.raisedAt), kind: "DisputeRaised", dispute: d.address, target: d.target, targetKind: kind, by: d.disputer });
    if (d.status === "Upheld" || d.status === "Dismissed") out.push({ ...b(d.raisedAt), kind: "DisputeResolved", dispute: d.address, target: d.target, targetKind: kind, upheld: d.status === "Upheld" });
  }

  // Assets: registered (by title, kind only), and sold under the rules (to whom the proceeds went; never the price).
  const registered = act.filter((a) => a.kind === "AssetRegistered");
  snap.assets.forEach((a, i) => {
    const at = registered[i]?.ts ?? created;
    out.push({ ...b(at, registered[i]?.txSignature ?? ""), kind: "AssetRegistered", asset: a.address, title: a.title, assetKind: opts.assetKinds?.[a.address] ?? assetKindFromTitle(a.title) });
    if (a.status === "Sold") {
      const sale = act.find((x) => x.kind === "AssetSold" && x.sale?.asset === a.address) ?? act.find((x) => x.kind === "AssetSold");
      out.push({ ...b(sale?.ts ?? at, sale?.txSignature ?? ""), kind: "AssetSold", asset: a.address, recipient: sale?.sale?.recipient ?? a.proceedsTo, hardship: !!sale?.sale?.hardship });
    }
  });
  return out.sort((x, y) => x.ts - y.ts);
}
