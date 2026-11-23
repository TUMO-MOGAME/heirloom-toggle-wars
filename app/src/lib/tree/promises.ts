/**
 * Promise rules (plan.md §15.4): estate events → kept promises and asset paths. Pure functions, one per rule.
 *
 * Facts, mostly positive, never scores and never amounts:
 *  - Only an upheld challenge is negative ("challengeUpheld", on the claim's beneficiary).
 *  - Vetoed passings, dismissed or lapsed disputes and objections, withdrawn offers: nothing, for or against anyone.
 *  - Approvals of a claim that a challenge or objection later cancelled are not counted as kept.
 * Grouping: one KeptPromise per (kind, who kept it, who it was for, purpose, estate, real/imagined), with the count
 * of events, their times (`tss`) and up to five proofs, newest first.
 */
import type { Base58, Category } from "../types";
import type { AssetPath, AssetStep, KeptKind, KeptPromise, PersonId } from "./types";
import type { TreeEvent } from "./events";

export interface PromiseContext {
  /** The owner of each estate. */
  owners: Record<Base58, PersonId>;
  /** Where an ongoing guardian term ends on the record (unix seconds): the latest fact known for that estate. */
  until?: Record<Base58, number>;
}

type Ev<K extends TreeEvent["kind"]> = Extract<TreeEvent, { kind: K }>;
const of = <K extends TreeEvent["kind"]>(events: TreeEvent[], kind: K) => events.filter((e): e is Ev<K> => e.kind === kind);

/** What the rules need to look up: rules, claims, hardships and each estate's beneficiaries, from the facts. */
export interface Lookups {
  rules: Map<Base58, { category: Category; beneficiary: Base58 }>;
  claims: Map<Base58, { rule: Base58; beneficiary: Base58 }>;
  hardships: Map<Base58, { beneficiary: Base58 }>;
  beneficiaries: Map<Base58, Base58[]>;
  /** Claims whose payment a challenge (dispute) or an objection cancelled. */
  cancelled: Set<Base58>;
}

export function lookups(events: TreeEvent[]): Lookups {
  const l: Lookups = { rules: new Map(), claims: new Map(), hardships: new Map(), beneficiaries: new Map(), cancelled: new Set() };
  for (const e of events) {
    if (e.kind === "RuleSet") l.rules.set(e.rule, { category: e.category, beneficiary: e.beneficiary });
    else if (e.kind === "ClaimSubmitted") l.claims.set(e.claim, { rule: e.rule, beneficiary: e.beneficiary });
    else if (e.kind === "HardshipSubmitted") l.hardships.set(e.hardship, { beneficiary: e.beneficiary });
    else if (e.kind === "BeneficiaryAdded") {
      const list = l.beneficiaries.get(e.estate) ?? [];
      if (!list.includes(e.wallet)) list.push(e.wallet);
      l.beneficiaries.set(e.estate, list);
    } else if ((e.kind === "DisputeResolved" || e.kind === "ObjectionResolved") && e.upheld && e.targetKind === "Claim") l.cancelled.add(e.target);
  }
  return l;
}

/* ---------- grouping ---------- */

interface Item {
  kind: KeptKind; by: PersonId; for: PersonId[]; about?: PersonId; estate: Base58; purpose?: string;
  ts: number; sig: string; imagined: boolean; withOthers?: number;
}

/** Groups items with the same kind, keeper, people, purpose, estate and real/imagined into one KeptPromise. */
export function group(items: Item[], opts: { separate?: boolean } = {}): KeptPromise[] {
  const groups = new Map<string, Item[]>();
  items.forEach((it, i) => {
    const k = [it.kind, it.estate, it.by, [...it.for].sort().join(","), it.about ?? "", it.purpose ?? "", it.imagined ? "i" : "r", opts.separate ? `${it.ts}:${i}` : ""].join("|");
    const list = groups.get(k) ?? [];
    list.push(it);
    groups.set(k, list);
  });
  const out: KeptPromise[] = [];
  for (const [k, list] of groups) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    const first = sorted[0];
    const proofs = [...new Set(sorted.map((x) => x.sig).filter(Boolean).reverse())].slice(0, 5);
    out.push({
      id: `kept:${k}`,
      kind: first.kind, by: first.by, for: [...first.for], ...(first.about ? { about: first.about } : {}),
      estate: first.estate, count: sorted.length,
      ...(first.withOthers !== undefined ? { withOthers: first.withOthers } : {}),
      ...(first.purpose ? { purpose: first.purpose } : {}),
      firstTs: first.ts, lastTs: sorted[sorted.length - 1].ts,
      tss: sorted.map((x) => x.ts),
      proofs, imagined: first.imagined,
    });
  }
  return out;
}

const imag = (e: TreeEvent) => !!e.imagined;

/* ---------- the rules ---------- */

/**
 * Rule 1: "Confirmed {owner}'s passing, with {n} others". Each trusted person who confirmed, counted only once the
 * unlock went through (a veto clears the confirmations before it). A seat holder's passing likewise counts for the
 * person who confirmed it once the succession (or the seat's vacancy) went through.
 */
export function confirmedPassing(events: TreeEvent[], ctx: PromiseContext): KeptPromise[] {
  const items: Item[] = [];
  const byEstate = new Map<Base58, TreeEvent[]>();
  for (const e of events) byEstate.set(e.estate, [...(byEstate.get(e.estate) ?? []), e]);
  for (const [estate, list] of byEstate) {
    const owner = ctx.owners[estate];
    let attesters: Ev<"DeathAttested">[] = [];
    const seat = new Map<number, { holder?: Base58; confirm?: Ev<"SeatDeathConfirmed"> }>();
    for (const e of [...list].sort((a, b) => a.ts - b.ts)) {
      if (e.kind === "DeathAttested") { if (!attesters.some((a) => a.verifier === e.verifier)) attesters.push(e); }
      else if (e.kind === "DeathVetoed") attesters = [];
      else if (e.kind === "EstateUnlocked") {
        for (const a of attesters) items.push({ kind: "confirmedPassing", by: a.verifier, for: [], about: owner, estate, ts: a.ts, sig: a.sig, imagined: imag(a), withOthers: attesters.length - 1 });
        attesters = [];
      } else if (e.kind === "SeatDeathReported") seat.set(e.seat, { holder: e.holder });
      else if (e.kind === "SeatDeathConfirmed") seat.set(e.seat, { ...seat.get(e.seat), confirm: e });
      else if (e.kind === "SeatDeathVetoed") seat.delete(e.seat);
      else if (e.kind === "SuccessionFinalized" || e.kind === "SeatVacated") {
        const s = seat.get(e.seat);
        if (s?.confirm) items.push({ kind: "confirmedPassing", by: s.confirm.by, for: [], about: s.holder ?? e.previous, estate, ts: s.confirm.ts, sig: s.confirm.sig, imagined: imag(s.confirm), withOthers: 0 });
        seat.delete(e.seat);
      }
    }
  }
  return group(items, { separate: true });
}

/** Rule 2: "Approved {n} payments for {person}": trusted people's and seat holders' claim approvals (one per claim and person). */
export function approvedPayments(events: TreeEvent[], l: Lookups = lookups(events)): KeptPromise[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  const add = (e: TreeEvent, claim: Base58, by: Base58) => {
    if (l.cancelled.has(claim) || seen.has(`${claim}:${by}`)) return;
    seen.add(`${claim}:${by}`);
    const c = l.claims.get(claim);
    const rule = c ? l.rules.get(c.rule) : undefined;
    items.push({ kind: "approvedPayments", by, for: c ? [c.beneficiary] : [], estate: e.estate, ...(rule ? { purpose: rule.category } : {}), ts: e.ts, sig: e.sig, imagined: imag(e) });
  };
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.kind === "ClaimApproved") add(e, e.claim, e.verifier);
    else if (e.kind === "SeatApproval" && e.targetKind === "Claim") add(e, e.target, e.approver);
  }
  return group(items);
}

/** Rule 3: "Answered {n} requests from {person}": the owner approved living-plan claims while alive. */
export function answeredRequests(events: TreeEvent[], l: Lookups = lookups(events)): KeptPromise[] {
  return group(of(events, "ClaimOwnerApproved").filter((e) => !l.cancelled.has(e.claim)).map((e) => {
    const c = l.claims.get(e.claim);
    return { kind: "answeredRequests" as const, by: e.owner, for: c ? [c.beneficiary] : [], estate: e.estate, ts: e.ts, sig: e.sig, imagined: imag(e) };
  }));
}

/** Rule 4: "{rule purpose} for {person}, {years}": the plan paid by its rules (claims and schedules), credited to the owner. */
export function planPaid(events: TreeEvent[], ctx: PromiseContext, l: Lookups = lookups(events)): KeptPromise[] {
  const items: Item[] = [];
  for (const e of events) {
    if (e.kind !== "ClaimPaid" && e.kind !== "ScheduledPaid") continue;
    const owner = ctx.owners[e.estate];
    if (!owner) continue;
    const c = e.kind === "ClaimPaid" ? l.claims.get(e.claim) : undefined;
    const rule = l.rules.get(e.rule);
    const who = c?.beneficiary ?? rule?.beneficiary;
    items.push({ kind: "planPaid", by: owner, for: who ? [who] : [], estate: e.estate, ...(rule ? { purpose: rule.category } : {}), ts: e.ts, sig: e.sig, imagined: imag(e) });
  }
  return group(items);
}

/** Rule 5: "Helped {person} through a hard time": the approvers of a hardship request that reached its quorum. */
export function helpedHardship(events: TreeEvent[], l: Lookups = lookups(events)): KeptPromise[] {
  const approvals = of(events, "HardshipApproved");
  const passed = new Set(approvals.filter((a) => a.quorum).map((a) => a.hardship));
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const a of approvals) {
    if (!passed.has(a.hardship) || seen.has(`${a.hardship}:${a.verifier}`)) continue;
    seen.add(`${a.hardship}:${a.verifier}`);
    const h = l.hardships.get(a.hardship);
    items.push({ kind: "helpedHardship", by: a.verifier, for: h ? [h.beneficiary] : [], estate: a.estate, ts: a.ts, sig: a.sig, imagined: imag(a) });
  }
  return group(items);
}

/**
 * Rule 6: "Guardian of {person}, {from}–{to}": a seat holder's term, from when guardians were set up for them
 * (SeatConfigured) or they took the seat over (SuccessionFinalized), to when the seat passed on or emptied. An
 * ongoing term runs to the latest fact on the estate's record. For: the estate's beneficiaries.
 */
export function guardianTerms(events: TreeEvent[], ctx: PromiseContext, l: Lookups = lookups(events)): KeptPromise[] {
  const out: KeptPromise[] = [];
  const open = new Map<string, { holder: Base58; start: TreeEvent }>();
  const last = new Map<Base58, number>();
  for (const e of events) last.set(e.estate, Math.max(last.get(e.estate) ?? 0, e.ts));
  const close = (k: string, end: TreeEvent | null) => {
    const t = open.get(k);
    if (!t) return;
    open.delete(k);
    const estate = t.start.estate;
    const lastTs = end?.ts ?? Math.max(ctx.until?.[estate] ?? 0, last.get(estate) ?? t.start.ts);
    const proofs = [end?.sig, t.start.sig].filter((s): s is string => !!s);
    out.push({
      id: `kept:guardianTerm|${k}|${t.holder}|${t.start.ts}`, kind: "guardianTerm", by: t.holder,
      for: (l.beneficiaries.get(estate) ?? []).filter((w) => w !== t.holder), estate, count: 1,
      firstTs: t.start.ts, lastTs, tss: [t.start.ts], proofs, imagined: imag(t.start),
    });
  };
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.kind === "SeatConfigured") {
      const k = `${e.estate}:${e.seat}`;
      const cur = open.get(k);
      if (cur?.holder === e.holder) continue;
      close(k, e);
      if (e.holder) open.set(k, { holder: e.holder, start: e });
    } else if (e.kind === "SuccessionFinalized") {
      const k = `${e.estate}:${e.seat}`;
      close(k, e);
      open.set(k, { holder: e.next, start: e });
    } else if (e.kind === "SeatVacated") close(`${e.estate}:${e.seat}`, e);
  }
  for (const k of [...open.keys()]) close(k, null);
  return out;
}

/** Rule 7: "Carried out {owner}'s fallback plan": the vault went to the fallback recipient (credited to the owner's plan). */
export function carriedOutFallback(events: TreeEvent[], ctx: PromiseContext): KeptPromise[] {
  return group(of(events, "FallbackExecuted").filter((e) => ctx.owners[e.estate]).map((e) => ({
    kind: "carriedOutFallback" as const, by: ctx.owners[e.estate], about: ctx.owners[e.estate], for: [e.recipient], estate: e.estate, ts: e.ts, sig: e.sig, imagined: imag(e),
  })), { separate: true });
}

/**
 * Rule 8: an upheld challenge. The person who raised it: "Raised a challenge that was upheld" (positive), for a
 * dispute and for a monitor's objection. On a claim's beneficiary: "A challenge against this claim was upheld", the
 * only negative fact. Dismissed or lapsed challenges give nothing to anyone.
 */
export function challenges(events: TreeEvent[], ctx: PromiseContext, l: Lookups = lookups(events)): KeptPromise[] {
  const items: Item[] = [];
  const raised = new Map<Base58, Ev<"DisputeRaised"> | Ev<"ObjectionRaised">>();
  for (const e of events) if (e.kind === "DisputeRaised") raised.set(e.dispute, e); else if (e.kind === "ObjectionRaised") raised.set(e.objection, e);
  for (const e of events) {
    if ((e.kind !== "DisputeResolved" && e.kind !== "ObjectionResolved") || !e.upheld) continue;
    const r = raised.get(e.kind === "DisputeResolved" ? e.dispute : e.objection);
    const claim = e.targetKind === "Claim" ? l.claims.get(e.target) : undefined;
    const about = claim?.beneficiary ?? (e.targetKind === "Unlock" ? ctx.owners[e.estate] : undefined);
    if (r) items.push({ kind: "raisedUpheldChallenge", by: r.by, for: [], ...(about ? { about } : {}), estate: e.estate, ts: e.ts, sig: e.sig, imagined: imag(e) });
    if (e.kind === "DisputeResolved" && claim) items.push({ kind: "challengeUpheld", by: claim.beneficiary, for: [], estate: e.estate, ts: e.ts, sig: e.sig, imagined: imag(e) });
  }
  return group(items, { separate: true });
}

/** Every kept promise, oldest first. */
export function keptPromises(events: TreeEvent[], ctx: PromiseContext): KeptPromise[] {
  const l = lookups(events);
  return [
    ...confirmedPassing(events, ctx), ...approvedPayments(events, l), ...answeredRequests(events, l), ...planPaid(events, ctx, l),
    ...helpedHardship(events, l), ...guardianTerms(events, ctx, l), ...carriedOutFallback(events, ctx), ...challenges(events, ctx, l),
  ].sort((a, b) => a.firstTs - b.firstTs || a.id.localeCompare(b.id));
}

/**
 * Rule 9: asset paths. Registered → held by the plan (from the owner's passing) → passed to an heir, or sold under the
 * rules (to whom the proceeds went when that is a person; never the buyer or the price). An heir who registers the
 * asset they received in their own plan continues the same path (one journey across generations, not two).
 */
export function assetPaths(events: TreeEvent[], ctx: PromiseContext): AssetPath[] {
  const paths = new Map<Base58, AssetPath>();
  /** The plan that holds each asset now, and where its current stretch starts in `steps`. */
  const holder = new Map<Base58, { estate: Base58; from: number }>();
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const stretch = (p: AssetPath, asset: Base58) => p.steps.slice(holder.get(asset)!.from);
  for (const e of sorted) {
    if (e.kind === "AssetRegistered") {
      const p = paths.get(e.asset);
      const reg: AssetStep = { kind: "registered", ts: e.ts, ...(e.sig ? { proof: e.sig } : {}), imagined: imag(e) };
      if (!p) {
        paths.set(e.asset, { id: `asset:${e.estate}:${e.asset}`, kind: e.assetKind, title: e.title, owner: ctx.owners[e.estate] ?? "", estate: e.estate, steps: [reg] });
        holder.set(e.asset, { estate: e.estate, from: 0 });
        continue;
      }
      // Re-registered by the heir it passed to: the path carries on in their plan.
      const last = p.steps[p.steps.length - 1];
      if (holder.get(e.asset)!.estate !== e.estate && last.kind === "passedTo" && last.to && last.to === ctx.owners[e.estate]) {
        holder.set(e.asset, { estate: e.estate, from: p.steps.length });
        p.steps.push(reg);
      }
    } else if (e.kind === "EstateUnlocked") {
      for (const [asset, p] of paths) {
        if (holder.get(asset)!.estate !== e.estate || stretch(p, asset).some((s) => s.kind !== "registered")) continue;
        p.steps.push({ kind: "heldByPlan", ts: e.ts, ...(e.sig ? { proof: e.sig } : {}), imagined: imag(e) });
      }
    } else if (e.kind === "AssetSold" || e.kind === "AssetPassed") {
      const p = paths.get(e.asset);
      if (!p || holder.get(e.asset)!.estate !== e.estate || stretch(p, e.asset).some((s) => s.kind === "soldUnderRules" || s.kind === "passedTo")) continue;
      const to = e.kind === "AssetPassed" ? e.to : e.recipient && e.recipient !== e.estate ? e.recipient : undefined;
      p.steps.push({ kind: e.kind === "AssetSold" ? "soldUnderRules" : "passedTo", ts: e.ts, ...(to ? { to } : {}), ...(e.sig ? { proof: e.sig } : {}), imagined: imag(e) });
    }
  }
  return [...paths.values()];
}
