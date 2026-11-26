/**
 * Mock twin of the guardians part of the contract (docs/guardians-spec.md §2): seats with backups and monitors,
 * approval stamps and the objection window, objections and votes, succession, the fallback plan and asset photos.
 * Same checks and error names as the program, so the UI behaves the same in mock and chain mode.
 *
 * Synchronous "instructions" only; mock.ts wraps them in the async GuardiansService methods (hashing, the agent's
 * review, latency) and calls the hooks (recordApproval, check*) from its existing instructions.
 */
import type { AgentReport, Asset, Base58, Claim, PaymentRef } from "../types";
import type { SaleTiming } from "../agent/offers";
import type { EstateSnapshot, TxResult } from "./types";
import type {
  AssetKind, AssetMediaInfo, AssetPhoto, FallbackRecipient, GuardiansSnapshot, ObjectionStatus, Seat, SeatApprovalItem, TargetKind,
} from "../guardians/types";
import { fail, need } from "./mock-errors";
import { shortName } from "../names";
import { cleanSpec, foreignSpecKeys, isPhotoLabel, type AssetSpec } from "../assets/spec";
import { objectionLapsesAt } from "../disputes/types";
import { eligibleSeats, fallbackGrace, MIN_WAIT_SECS, refuteWait, replaceableAt, seatReviewedHold } from "../death-rules";
import { openToPeople } from "../verdict";
import { confirmRoute, deathSince, interestedIn, NO_WALLET, successionOutcome } from "../guardians/decisions";
import { clearDeath, COLLECTING, proofOfLife, votesCount, type MockStamp } from "./mock-rules";

/** Demo timings: objection window, succession wait and fallback wait (real: 2 days, 7 days, 90 days). */
export const GUARD_DEMO_TIMINGS = { objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 } as const;
export const VACANT_KEY = NO_WALLET;
/** The program's MAX_PHOTOS (raised from 8 to 24 on 15 Nov 2026). */
export const MAX_PHOTOS = 24;

export interface Named { wallet: Base58; name: string }
export type FallbackInput = { wallet: Base58; name: string; kind: FallbackRecipient["kind"] };

interface MockSuccession {
  certHash: string;
  reportedBy: Base58;
  verdict: "Pending" | "Approved" | "Rejected";
  report?: AgentReport;
  confirmedBy: Base58 | null;
  /** When it was reported (absent: saved before times were stored, so long stale). */
  reportedAt?: number;
  /** When the wait started. The demo's "end the wait" moves it back. */
  pendingSince: number;
  /** When it was confirmed, never moved. */
  confirmedAt?: number;
}

/** FallbackReport: an open report that a fallback recipient died (R4). */
interface MockFallbackReport {
  recipient: Base58;
  reporter: Base58;
  certHash: string;
  verdict: "Pending" | "Approved";
  report?: AgentReport;
  reportedAt: number;
}

interface MockSeat {
  address: Base58;
  index: number;
  holder: Base58 | null;
  backups: Base58[];
  monitors: Base58[];
  generation: number;
  vacant: boolean;
  succession: MockSuccession | null;
}

interface MockObjection {
  address: Base58;
  kind: TargetKind;
  target: Base58;
  monitor: Base58;
  seatIndex: number | null;
  reason: string;
  reasonHash: string;
  raisedAt: number;
  status: ObjectionStatus;
  votesUphold: number;  // bitmap of seats (Fallback: of monitors, bit = seat * 2 + slot)
  votesDismiss: number;
  /** Sale: raised again after an upheld one, whose cut-off it keeps (the program's SALE_CUTOFF_KEPT, P5). */
  keepsSaleCutoff?: boolean;
}

export interface MockGuardState {
  address: Base58;
  enabled: boolean;
  objectionWindowSecs: number;
  successionWaitSecs: number;
  fallbackWaitSecs: number;
  seats: MockSeat[];
  fallback: FallbackInput[];
  fallbackDead: boolean[];
  fallbackStartedAt: number | null;
  fallbackDone: boolean;
  /** ApprovalStamp per claim, with or without a Guard: whether approvals count, and the window. */
  stamps: Record<Base58, MockStamp>;
  /** Open reports by recipient index (added 22 Nov 2026; absent in older saved states). */
  fallbackReports?: Record<number, MockFallbackReport>;
  feed: SeatApprovalItem[];
  objections: MockObjection[];
  media: Record<Base58, { kind: AssetKind; title: string; description?: string; photos: AssetPhoto[]; spec?: AssetSpec; photosRoot: string; updatedAt: number }>;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeAddr = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join("");
const nowSecs = () => Math.floor(Date.now() / 1000);
const bitCount = (m: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => (m & (1 << i)) !== 0).length;

export function blankGuard(): MockGuardState {
  return {
    address: fakeAddr(), enabled: false, ...GUARD_DEMO_TIMINGS,
    seats: [], fallback: [], fallbackDead: [], fallbackStartedAt: null, fallbackDone: false,
    stamps: {}, feed: [], objections: [], media: {}, fallbackReports: {},
  };
}

export interface GuardDeps {
  guard(): MockGuardState;
  snap(): EstateSnapshot;
  names(): Record<Base58, string>;
  created(): boolean;
  me(): Base58;
  /** The latest dispute on a target: it shares the objection's place. Once decided, raisedAt is when it was decided. */
  dispute(target: Base58): { raisedAt: number; lapsesAt: number; status: string } | null;
  tx(): TxResult;
  log(kind: string, text: string, t: TxResult, amount?: bigint, payment?: PaymentRef): void;
  credit(wallet: Base58, amount: bigint): void;
  usd(amount: bigint): string;
}

export function createMockGuardians(d: GuardDeps) {
  const g = () => d.guard();
  /** Guard::succession_wait: at least 60 s (a stored 0 waits 60 s), so a living holder always has time to answer. */
  const successionWait = () => Math.max(MIN_WAIT_SECS, g().successionWaitSecs);
  const est = () => d.snap().estate;
  const name = (a: Base58) => d.names()[a] ?? "Someone";
  const first = (a: Base58) => shortName(name(a)); // the short form used in sentences (lib/names)
  const remember = (people: Named[]) => { for (const p of people) if (p.name && !(p.wallet in d.names())) d.names()[p.wallet] = p.name; };

  const needCreated = () => need(d.created(), "NoEstate", "There is no estate yet. The owner signs the will first.");
  const needGuard = () => { needCreated(); need(g().enabled, "BadStatus", "Guardians are not set up for this estate."); };
  const needOwnerActive = () => {
    need(d.me() === est().owner, "NotOwner", "Only the estate owner can do this.");
    need(est().status === "Active", "BadStatus", "This can only change while the estate is active.");
  };
  const seat = (index: number) => g().seats.find((s) => s.index === index) ?? fail("BadStatus", "That trusted person's seat does not exist.");
  /** The owner showed life after it was raised, so the death it challenged, and any votes on it, are void. */
  const voidedByOwner = (o: MockObjection) => (o.kind === "Unlock" || o.kind === "Fallback") && o.raisedAt < est().lastHeartbeat;
  /** An Open objection lapses (counts as dismissed): Fallback after the fallback wait, the others after two waiting periods. */
  function lapsesAt(o: MockObjection): number | null {
    if (o.status !== "Open") return null;
    const at = o.kind === "Fallback" ? o.raisedAt + g().fallbackWaitSecs : objectionLapsesAt(o.raisedAt, est().waitingPeriodSecs);
    return voidedByOwner(o) ? Math.min(at, est().lastHeartbeat) : at;
  }
  const lapsed = (o: MockObjection) => { const at = lapsesAt(o); return at !== null && nowSecs() >= at; };
  /** Open and binding. A Fallback one binds until it is closed as lapsed. */
  const binding = (o: MockObjection) => o.status === "Open" && (o.kind === "Fallback" || !lapsed(o));
  const openObjection = (target: Base58) => g().objections.find((o) => o.target === target && binding(o));
  const objectionBinds = (target: Base58) => !!openObjection(target);
  const interested = (kind: TargetKind, target: Base58) => (kind === "Fallback"
    ? g().fallback.find((_r, k) => !g().fallbackDead[k])?.wallet ?? null
    : interestedIn(d.snap(), kind, target));
  /** Votes of vacant seats don't count. Monitors' bits are positions, not seats. */
  const countedVotes = (o: MockObjection, votes: number) =>
    o.kind === "Fallback" ? votes : eligibleSeats(est().verifiers).reduce((all, i) => all | (votes & (1 << i)), 0);
  const named = (w: Base58): Named => ({ wallet: w, name: name(w) });
  const seatView = (s: MockSeat): Seat => ({
    address: s.address, index: s.index, holder: s.holder, holderName: s.holder ? name(s.holder) : "", backups: s.backups.map(named),
    monitors: s.monitors.map(named), generation: s.generation, vacant: s.vacant,
    succession: s.succession ? { ...s.succession, readyAt: 0, nextHolder: null } : null,
  });
  function promotedNext(s: MockSeat): Named | null {
    const o = successionOutcome(est(), seatView(s));
    return o.kind === "promote" ? o.next : null;
  }
  function markLapsed(o: MockObjection) {
    o.status = "Dismissed";
    d.log("ObjectionResolved", o.kind === "Fallback" ? "The objection lapsed: it was not upheld in time, so the fallback plan can go ahead" : "The objection lapsed: it was not upheld in time, so the paused step can go ahead", d.tx());
  }

  function createSeats() {
    const e = est();
    for (const index of [0, 1, 2]) {
      if (g().seats.some((s) => s.index === index)) continue;
      const holder = e.verifiers[index] && e.verifiers[index] !== VACANT_KEY ? e.verifiers[index] : null;
      g().seats.push({ address: fakeAddr(), index, holder, backups: [], monitors: [], generation: 0, vacant: !holder, succession: null });
    }
    g().seats.sort((a, b) => a.index - b.index);
  }

  function validBackups(index: number, wallets: Base58[]) {
    need(wallets.length <= 2, "BadBackup", "Name at most two backups.");
    need(new Set(wallets).size === wallets.length, "BadBackup", "The same person is named twice.");
    const holders = est().verifiers;
    for (const w of wallets) {
      need(!!w && w !== VACANT_KEY, "BadBackup", "A backup needs a wallet address.");
      need(w !== est().owner, "BadBackup", "The owner cannot be a backup.");
      need(w !== est().agent, "BadBackup", "The agent cannot be a backup.");
      need(w !== seat(index).holder, "BadBackup", "A trusted person cannot be their own backup.");
      need(!holders.includes(w), "BadBackup", "This person already holds another seat.");
    }
  }

  function validMonitors(index: number, wallets: Base58[]) {
    need(wallets.length <= 2, "BadMonitor", "Name at most two monitors.");
    need(new Set(wallets).size === wallets.length, "BadMonitor", "The same person is named twice.");
    for (const w of wallets) {
      need(!!w && w !== VACANT_KEY, "BadMonitor", "A monitor needs a wallet address.");
      need(w !== seat(index).holder, "BadMonitor", "A trusted person cannot watch themselves.");
    }
  }

  function validFallback(list: FallbackInput[]) {
    need(list.length <= 4, "BadFallback", "Name at most four fallback recipients.");
    need(new Set(list.map((r) => r.wallet)).size === list.length, "BadFallback", "The same recipient is named twice.");
    for (const r of list) {
      need(!!r.wallet && r.wallet !== VACANT_KEY, "BadFallback", "Each recipient needs a wallet address.");
      need(r.wallet !== est().owner, "BadFallback", "The owner cannot be a fallback recipient.");
    }
  }

  /* ----- owner setup ----- */

  /** lib/service/chain-guardians.ts `defaultMonitor`: not who would take the seat, rather not a trusted person, spread out. */
  function watcherFor(index: number, holder: Base58 | null, backup: Base58 | undefined): Base58 | null {
    const { owner, verifiers } = est();
    const able = d.snap().beneficiaries.filter((b) => b.active)
      .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }) || a.wallet.localeCompare(b.wallet))
      .map((b) => b.wallet).filter((w) => w !== holder && w !== backup && w !== owner);
    const outside = able.filter((w) => !verifiers.includes(w));
    const pool = outside.length ? outside : able;
    return pool.length ? pool[index % pool.length] : null;
  }

  function setup(input: {
    seats: { index: number; backups: Named[]; monitors: Named[] }[];
    fallback: FallbackInput[];
  }): TxResult[] {
    needCreated(); needOwnerActive();
    const txs: TxResult[] = [];
    const watchers = new Map<number, Base58>();
    if (!g().enabled) {
      g().enabled = true;
      createSeats();
      // A seat made without a monitor gets one from the active family, as on the chain.
      for (const s of g().seats) {
        const asked = input.seats.find((x) => x.index === s.index);
        if (asked?.monitors.length) continue;
        const watcher = watcherFor(s.index, s.holder, asked?.backups[0]?.wallet);
        if (!watcher) continue;
        watchers.set(s.index, watcher);
        s.monitors = [watcher];
      }
      const t = d.tx(); txs.push(t);
      d.log("GuardCreated", "Guardians switched on: approvals now wait for an objection window", t);
    }
    for (const s of input.seats) {
      need(s.index >= 0 && s.index <= 2, "BadStatus", "There are only three trusted people.");
      remember([...s.backups, ...s.monitors]);
      txs.push(setBackups(s.index, s.backups.map((b) => b.wallet)));
      const watcher = watchers.get(s.index);
      txs.push(setMonitors(s.index, watcher ? [watcher] : s.monitors.map((m) => m.wallet)));
    }
    if (input.fallback.length) txs.push(setFallback(input.fallback));
    return txs;
  }

  function setBackups(index: number, wallets: Base58[]): TxResult {
    needGuard();
    const s = seat(index);
    const isHolder = !!s.holder && d.me() === s.holder;
    if (!isHolder) needOwnerActive();
    validBackups(index, wallets);
    if (s.succession) {
      need(reportStale(s.succession, d.me()), "SuccessionPending", "A passing is being confirmed for this seat.");
      s.succession = null;
      d.log("SeatDeathReportCleared", "A passing reported for this seat went unconfirmed too long, so the report was cleared", d.tx());
    }
    s.backups = [...wallets];
    const t = d.tx();
    const who = s.holder ? first(s.holder) : "this seat";
    d.log("SeatBackupsSet", wallets.length ? `Backups for ${who}: ${wallets.map(first).join(", then ")}` : `${who} has no backups`, t);
    return t;
  }

  function setMonitors(index: number, wallets: Base58[]): TxResult {
    needGuard(); needOwnerActive();
    const s = seat(index);
    validMonitors(index, wallets);
    // Someone watches this seat from now on, so a family member's confirmation gives way to theirs (R18).
    if (s.succession?.confirmedBy && wallets.length && confirmRoute(est(), seatView(s)) === "family") {
      s.succession = null;
      d.log("SeatDeathReportCleared", "This seat has a monitor now, so the family's confirmation was cleared", d.tx());
    }
    s.monitors = [...wallets];
    const t = d.tx();
    d.log("SeatMonitorsSet", wallets.length
      ? `${wallets.map(first).join(" and ")} now ${wallets.length > 1 ? "watch" : "watches"} ${s.holder ? first(s.holder) : "this seat"}'s approvals`
      : `Nobody watches ${s.holder ? first(s.holder) : "this seat"} now`, t);
    return t;
  }

  function setFallback(list: FallbackInput[]): TxResult {
    needGuard(); needOwnerActive();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    validFallback(list);
    remember(list);
    g().fallback = list.map((r) => ({ ...r }));
    g().fallbackDead = list.map(() => false);
    g().fallbackStartedAt = null; // the owner is alive and changing the plan: a started countdown is void
    g().fallbackReports = {}; // and every open report about a recipient is void
    const t = d.tx();
    d.log("FallbackSet", `Fallback order set: ${list.map((r) => r.name).join(", then ")}`, t);
    return t;
  }

  /**
   * owner_replace_seat: the living owner swaps the person in a seat (or fills an empty one); proof of life. Same checks as the
   * program: the owner, estate Active (BadStatus), the new holder set, not the owner and not holding any seat
   * (DuplicateVerifier). Backups and monitors stay, minus the new holder; a reported passing is cleared.
   */
  function replaceSeat(index: number, newHolder: Named): TxResult {
    needGuard(); needOwnerActive();
    const s = seat(index);
    const e = est();
    const w = newHolder.wallet.trim();
    need(!!w && w !== VACANT_KEY, "DuplicateVerifier", "The new trusted person needs a wallet address.");
    need(w !== e.owner, "DuplicateVerifier", "The owner cannot be their own trusted person.");
    need(!e.verifiers.includes(w), "DuplicateVerifier", "This person already holds a trusted place.");
    need(w !== e.agent, "BadAgent", "The agent cannot be a trusted person.");
    remember([{ wallet: w, name: newHolder.name.trim() }]);
    const previous = s.holder;
    s.holder = w;
    s.backups = s.backups.filter((b) => b !== w);
    s.monitors = s.monitors.filter((m) => m !== w);
    s.vacant = false;
    s.generation += 1;
    s.succession = null;
    e.verifiers[index] = w;
    e.verifierNames[index] = name(w);
    const t = d.tx();
    // Only the living owner can do this, and it revokes what the replaced person attested (R2).
    proofOfLife(e, nowSecs(), d.log, d.tx);
    d.log("SeatConfigured", previous ? `${name(w)} replaces ${name(previous)} as a trusted person` : `${name(w)} fills an empty trusted place`, t);
    return t;
  }

  /* ----- approvals, stamps and the objection window (hooks for mock.ts) ----- */

  /** SeatApproval event: called by attest_death / approve_claim / approve_hardship. */
  function recordApproval(item: { kind: TargetKind; seatIndex: number; target: Base58; summary: string; t: TxResult; deadline: number | null }) {
    if (!g().enabled) return;
    const approver = d.me();
    g().feed.unshift({
      seatIndex: item.seatIndex, approver, approverName: name(approver), kind: item.kind, target: item.target,
      summary: item.summary, ts: nowSecs(), txSignature: item.t.signature, objectionDeadline: item.deadline,
    });
  }

  const countsFor = (c: Claim) => votesCount(g().stamps[c.address], c, est());

  /**
   * approve_claim's stamp: collecting until the quorum, then the window runs from when it was reached, again if it
   * had been lost. Returns when the claim may be paid, or null while it can't be.
   */
  function recordStamp(claim: Claim, seatIndex: number, starts: boolean): number | null {
    const stamps = g().stamps;
    if (starts) stamps[claim.address] = { seatIndex, approver: d.me(), approvedAt: nowSecs(), givenAt: nowSecs() };
    else if (!stamps[claim.address]?.approvedAt) stamps[claim.address] = { seatIndex: COLLECTING, approver: d.me(), approvedAt: 0 };
    return payableAt(claim.address);
  }

  /** With a Guard: when the window closes. A dispute held the objection's place, so the window follows it. */
  function payableAt(claim: Base58): number | null {
    const st = g().stamps[claim];
    if (!g().enabled || !st?.approvedAt) return null;
    // Approved alone by the claimant (the only trusted person left): twice the window.
    const window = g().objectionWindowSecs * (d.snap().claims.find((c) => c.address === claim)?.decidedAlone ? 2 : 1);
    let at = st.approvedAt + window;
    const dispute = d.dispute(claim);
    if (dispute && !st.windowEnded && !g().objections.some((o) => o.target === claim && o.raisedAt > dispute.raisedAt)) {
      // After it lapsed, or after it was decided.
      at = Math.max(at, (dispute.status === "Upheld" || dispute.status === "Dismissed" ? dispute.raisedAt : dispute.lapsesAt) + window);
    }
    return at;
  }

  /** approve_hardship's ["stamp", hardship]: when the quorum was reached (with a Guard, the sale waits out the window). */
  function recordHardshipStamp(hardship: Base58, seatIndex: number) {
    g().stamps[hardship] = { seatIndex, approver: d.me(), approvedAt: nowSecs(), givenAt: nowSecs() };
  }

  /** What accept_offer checks against the clock (lib/agent/offers.ts SaleTiming), from this estate's state. */
  function saleTiming(asset: Asset): SaleTiming {
    // Objection::sale_cutoff: upheld, or raised again after one was upheld (P5).
    const upheld = g().objections.find((o) => o.kind === "Sale" && o.target === asset.address && (o.status === "Upheld" || o.keepsSaleCutoff));
    const hardship = asset.hardshipBeneficiary
      ? d.snap().hardships.find((h) => h.asset === asset.address && h.beneficiary === asset.hardshipBeneficiary)
      : undefined;
    const quorumAt = hardship ? g().stamps[hardship.address]?.approvedAt ?? 0 : 0;
    return {
      now: nowSecs(), objectionWindowSecs: g().enabled ? g().objectionWindowSecs : null,
      saleObjectionUpheldAt: upheld ? upheld.raisedAt : null, hardshipQuorumAt: quorumAt > 0 ? quorumAt : null,
    };
  }

  /** A living listed fallback recipient (they may report the owner's death). */
  const livingListed = (w: Base58) => g().enabled && g().fallback.some((r, i) => r.wallet === w && !g().fallbackDead[i]);

  /**
   * A new agent: what the old one reviewed is set back for the new one to review (AgentReviewCleared), a seat's report
   * with its confirmation, a fallback recipient's report with its time.
   */
  function clearAgentReviews() {
    const now = nowSecs();
    for (const s of g().seats) {
      const sc = s.succession;
      if (!sc || sc.verdict === "Pending") continue;
      Object.assign(sc, { verdict: "Pending", report: undefined, confirmedBy: null, confirmedAt: undefined, reportedAt: now, pendingSince: now });
      d.log("AgentReviewCleared", `The new agent will review again the reported passing of ${first(s.holder ?? "")}`, d.tx());
    }
    for (const r of Object.values(reports())) {
      if (r.verdict === "Pending") continue;
      Object.assign(r, { verdict: "Pending", report: undefined, reportedAt: now });
      d.log("AgentReviewCleared", `The new agent will review again the reported passing of ${first(r.recipient)}`, d.tx());
    }
  }

  /** A candidate agent is nobody's backup: the seat would lose that backup. */
  const isBackup = (w: Base58) => g().seats.some((s) => s.backups.includes(w));

  /** execute_claim with a Guard: the stamp must exist, the window must have passed, and no objection may be open. */
  function checkClaimExecutable(claim: Base58, byQuorum: boolean) {
    if (!g().enabled) return;
    need(!openObjection(claim), "ObjectionOpen", "A monitor objected. This payment waits until the objection is decided.");
    if (!byQuorum) return; // the owner's own approval (living plan) is not a seat approval
    const at = payableAt(claim) ?? fail("ObjectionWindowOpen", "This approval has not been recorded yet.");
    need(nowSecs() >= at, "ObjectionWindowOpen", "The objection window is still open. Try again shortly.");
  }

  /** finalize_unlock / accept_offer / hardship-gated sales: no open objection on the target. */
  function checkNotObjected(target: Base58) {
    if (!g().enabled) return;
    need(!openObjection(target), "ObjectionOpen", "A monitor objected. This waits until the objection is decided.");
  }

  /* ----- succession ----- */

  const isFamilyMember = (w: Base58) => d.snap().beneficiaries.some((b) => b.wallet === w && b.active);
  const isMonitorOfAny = (w: Base58) => g().seats.some((s) => s.monitors.includes(w));
  /** A living trusted person, this seat's monitor or an active beneficiary; never the agent. */
  const isParticipant = (who: Base58, s: MockSeat | null) =>
    who !== est().agent && who !== VACANT_KEY && (est().verifiers.includes(who) || !!s?.monitors.includes(who) || isFamilyMember(who));

  function reportStale(sc: MockSuccession, who: Base58): boolean {
    const w = est().waitingPeriodSecs;
    // A reviewed report stands long enough for the recovery route to open and be used (RT + 2W).
    return !sc.confirmedBy && nowSecs() >= replaceableAt({
      verdict: sc.verdict, reportedAt: sc.reportedAt ?? 0, reporter: sc.reportedBy, who, waitingSecs: w, hold: seatReviewedHold(w),
    });
  }

  /** report_seat_death + review_seat_death in one step (the agent's verdict is already known; null = not read yet). */
  function reportSeatDeath(index: number, certHash: string, report: AgentReport | null): TxResult {
    needGuard();
    const s = seat(index);
    const who = d.me();
    need(!s.vacant && !!s.holder, "SeatVacant", "This seat is already empty.");
    need(who !== s.holder, "BadStatus", "You cannot report your own passing.");
    need(isParticipant(who, s) || (who !== est().agent && (who === est().owner || s.backups.includes(who))),
      "NotParticipant", "Only the trusted people, the owner, the family, or this person's backups and monitors can report this.");
    need(!s.succession || reportStale(s.succession, who), "SuccessionPending", "A passing is already being confirmed for this seat.");
    const t = d.tx();
    d.log("SeatDeathReported", `${first(who)} reported that ${first(s.holder!)} has passed away`, t);
    s.succession = null;
    if (report && report.verdict !== "approve") {
      d.log("SeatDeathReviewed", "The agent could not accept the certificate. Nothing has changed", d.tx());
      return t;
    }
    // The wait starts when another person confirms (pendingSince stays 0 until then).
    s.succession = { certHash, reportedBy: who, verdict: report ? "Approved" : "Pending", report: report ?? undefined, confirmedBy: null, pendingSince: 0, reportedAt: nowSecs() };
    if (report) d.log("SeatDeathReviewed", `The agent read ${first(s.holder!)}'s death certificate and found no problems`, d.tx());
    return t;
  }

  /** Holders of the other seats (as on-chain: estate.verifiers[j] is set). */
  const otherLivingHolders = (index: number) =>
    est().verifiers.filter((v, j) => j !== index && !!v && v !== VACANT_KEY);

  function confirmSeatDeath(index: number): TxResult {
    needGuard();
    const s = seat(index);
    const sc = s.succession ?? fail("NoSuccessionPending", "No passing has been reported for this seat.");
    need(sc.verdict === "Approved", "AgentNotApproved", "The agent has not cleared the certificate.");
    need(!sc.confirmedBy, "AlreadyApproved", "This passing has already been confirmed.");
    const me = d.me();
    need(me !== sc.reportedBy, "NotConfirmer", "The person who reported the passing cannot also confirm it.");
    need(me !== s.holder, "NotConfirmer", "You cannot confirm your own passing.");
    need(me !== s.backups[0], "NotConfirmer", "The next holder cannot confirm their own promotion.");
    need(me !== est().agent, "NotConfirmer", "The agent only reviews.");
    const route = confirmRoute(est(), seatView(s));
    const allowed = route === "trusted" ? otherLivingHolders(index).includes(me)
      : route === "watchers" ? me === s.backups[1] || s.monitors.includes(me)
        : isFamilyMember(me); // R18: nobody else is left to confirm
    need(allowed, "NotConfirmer", route === "trusted" ? "Only another trusted person can confirm this."
      : route === "watchers" ? "Only this seat's second backup or a monitor can confirm this."
        : "Only a family member other than whoever reported it can confirm this.");
    sc.confirmedBy = me;
    sc.pendingSince = sc.confirmedAt = nowSecs();
    const t = d.tx();
    d.log("SeatDeathConfirmed", `${first(me)} confirmed ${first(s.holder!)}'s passing. ${s.backups[0] ? `${first(s.backups[0])} takes the seat after a short wait` : "The seat becomes empty after a short wait"}`, t);
    return t;
  }

  function vetoSeatDeath(index: number): TxResult {
    needGuard();
    const s = seat(index);
    need(!!s.succession, "NoSuccessionPending", "No passing has been reported for this seat.");
    need(d.me() === s.holder, "NotVerifier", "Only the person reported as passed can cancel this.");
    s.succession = null;
    const t = d.tx();
    d.log("SeatDeathVetoed", `${first(s.holder!)} said "I'm still here". The report was cancelled`, t);
    return t;
  }

  function finalizeSuccession(index: number): TxResult {
    needGuard();
    const s = seat(index);
    const sc = s.succession ?? fail("NoSuccessionPending", "No passing has been reported for this seat.");
    need(sc.verdict === "Approved", "AgentNotApproved", "The agent has not cleared the certificate.");
    need(!!sc.confirmedBy, "NotConfirmer", "Another trusted person must confirm the passing first.");
    need(nowSecs() >= sc.pendingSince + successionWait(), "WaitingPeriodNotOver", "The waiting period has not ended yet.");
    need(!openObjection(s.address), "ObjectionOpen", "A monitor objected. This waits until the objection is decided.");
    const gone = s.holder!;
    const e = est();
    const view = seatView(s);
    const clear = (text: string) => {
      s.succession = null;
      const t = d.tx();
      d.log("SeatDeathReportCleared", text, t);
      return t;
    };
    // The owner has since removed whoever confirmed, which revokes it. A confirmer who died instead keeps it.
    const by = sc.confirmedBy!;
    const route = confirmRoute(e, view);
    const mayStillConfirm = e.verifiers.includes(by)
      || (route !== "trusted" && (s.monitors.includes(by) || by === s.backups[1] || (route === "family" && by !== e.agent && isFamilyMember(by))));
    if ((sc.confirmedAt ?? sc.pendingSince) <= e.lastHeartbeat && !mayStillConfirm) {
      return clear("The owner removed the person who confirmed this passing, so the report was cleared");
    }
    const outcome = successionOutcome(e, view);
    // Only held back by this report: clear it, so someone else can report and the backup can take the seat (R10).
    if (outcome.kind === "clear") return clear("The only possible backup reported or confirmed this passing, so it must be reported again");
    const next = outcome.kind === "promote" ? outcome.next.wallet : null;
    const pick = next ? s.backups.indexOf(next) : -1;
    s.succession = null;
    s.generation += 1;
    const t = d.tx();
    if (next) {
      s.holder = next;
      s.backups = pick === 0 ? s.backups.slice(1) : [];
      s.monitors = s.monitors.filter((m) => m !== next);
      e.verifiers[index] = next;
      e.verifierNames[index] = name(next);
      d.log("SuccessionFinalized", `${first(next)} now holds ${first(gone)}'s seat as a trusted person`, t);
    } else {
      s.holder = null;
      s.vacant = true;
      s.backups = [];
      e.verifiers[index] = VACANT_KEY;
      d.log("SeatVacated", `${first(gone)}'s seat is now empty: no backup was left`, t);
    }
    return t;
  }

  /* ----- objections ----- */

  function targetIsLive(kind: TargetKind, target: Base58, seatIndex: number | null) {
    const sn = d.snap();
    switch (kind) {
      case "Claim": {
        const c = sn.claims.find((x) => x.address === target) ?? fail("BadStatus", "That claim does not exist.");
        need(c.status === "Open", "BadStatus", "This claim is already closed.");
        need(!!c.approvals[seatIndex ?? -1], "BadStatus", "The person you watch has not approved this.");
        return;
      }
      case "Hardship": {
        const h = sn.hardships.find((x) => x.address === target) ?? fail("BadStatus", "That request does not exist.");
        need(h.status === "Open" || h.status === "Approved", "BadStatus", "This request is already closed.");
        need(!!h.approvals[seatIndex ?? -1], "BadStatus", "The person you watch has not approved this.");
        need(sn.assets.find((a) => a.address === h.asset)?.status !== "Sold", "BadStatus", "The asset has already been sold.");
        return;
      }
      case "Sale": {
        const a = sn.assets.find((x) => x.address === target) ?? fail("BadStatus", "That asset does not exist.");
        need(a.status === "Listed", "BadStatus", "This asset is not for sale.");
        return;
      }
      case "Unlock":
        need(target === est().address, "BadStatus", "That is not this estate.");
        need(est().status === "DeathPending" || (est().status === "Active" && !!est().death.certHash), "BadStatus", "No passing is being confirmed.");
        return;
      case "Succession": {
        const s = seat(seatIndex ?? -1);
        need(target === s.address, "BadStatus", "That is not this seat.");
        need(!!s.succession, "NoSuccessionPending", "No passing has been reported for this seat.");
        return;
      }
      case "Fallback":
        need(target === g().address, "BadStatus", "That is not this estate's fallback plan.");
        need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
        need(countdownValid(), "FallbackNotReady", "The fallback plan is not running.");
    }
  }

  function raiseObjection(input: { kind: TargetKind; target: Base58; seatIndex: number | null; reason: string }, reasonHash: string): TxResult {
    needGuard();
    const me = d.me();
    const reason = input.reason.trim();
    need(reason.length > 0, "BadStatus", "Write a short reason.");
    need(reason.length <= 1000, "StringTooLong", "Keep the reason under 1,000 characters.");
    const seatSpecific = input.kind !== "Unlock" && input.kind !== "Fallback";
    if (seatSpecific) {
      need(input.seatIndex !== null && input.seatIndex >= 0 && input.seatIndex <= 2, "NotMonitor", "Choose the trusted person you watch.");
      need(seat(input.seatIndex!).monitors.includes(me), "NotMonitor", "Only a monitor of this trusted person can object.");
    } else {
      const anyMonitor = g().seats.some((s) => s.monitors.includes(me));
      const beneficiary = input.kind === "Fallback" && d.snap().beneficiaries.some((b) => b.wallet === me && b.active);
      need(anyMonitor || beneficiary, "NotMonitor", input.kind === "Fallback" ? "Only a monitor or a family member can object." : "Only a monitor can object.");
    }
    targetIsLive(input.kind, input.target, input.seatIndex);
    need(me !== interested(input.kind, input.target), "OwnClaimDispute", "You would gain if this went ahead, so you cannot be the one who challenges it.");
    // One objection per target at a time; a decided one may be raised again, except a dismissed one on a claim or
    // hardship. A dispute raised since took its place, and a finished dispute never uses the objection up.
    const prev = g().objections.find((o) => o.target === input.target);
    // An upheld sale objection keeps cutting off older offers after this one (P5).
    const keepsSaleCutoff = input.kind === "Sale" && !!prev && (prev.status === "Upheld" || !!prev.keepsSaleCutoff);
    if (prev) {
      need(!binding(prev), "ObjectionOpen", "An objection is already open on this.");
      const dispute = d.dispute(input.target);
      const dismissed = prev.status !== "Upheld" && !(dispute && dispute.raisedAt >= prev.raisedAt);
      if (dismissed) {
        const beforeThisDeath = prev.raisedAt < deathSince(est());
        if (input.kind === "Claim") need(est().status === "Unlocked" && beforeThisDeath, "BadStatus", "This objection was already dismissed.");
        if (input.kind === "Hardship") fail("BadStatus", "This objection was already dismissed.");
        if (input.kind === "Unlock") need(beforeThisDeath, "BadStatus", "This waiting period has already been challenged once.");
        if (input.kind === "Sale" || input.kind === "Succession") {
          const free = objectionLapsesAt(prev.raisedAt, est().waitingPeriodSecs) + Math.max(est().waitingPeriodSecs, 60);
          need(nowSecs() >= free, "ObjectionCooldown", "It is too soon to object to this again.");
        }
        // One fallback objection per countdown: a dismissed or lapsed one can't be raised again until it restarts.
        need(!(input.kind === "Fallback" && prev.raisedAt >= (g().fallbackStartedAt ?? Infinity)), "BadStatus", "An objection to this countdown was already decided.");
      }
      if (prev.status === "Open") markLapsed(prev);
      g().objections = g().objections.filter((o) => o !== prev);
    }
    g().objections.unshift({
      address: fakeAddr(), kind: input.kind, target: input.target, monitor: me, seatIndex: seatSpecific ? input.seatIndex : null,
      reason, reasonHash, raisedAt: nowSecs(), status: "Open", votesUphold: 0, votesDismiss: 0,
      ...(keepsSaleCutoff ? { keepsSaleCutoff } : {}),
    });
    remember([{ wallet: me, name: name(me) }]);
    const t = d.tx();
    const watched = seatSpecific ? seat(input.seatIndex!).holder : null;
    d.log("ObjectionRaised", `${first(me)} objected${watched ? ` to ${first(watched)}'s approval` : ""}. It is paused until the trusted people decide`, t);
    return t;
  }

  function resolve(o: MockObjection, upheld: boolean) {
    o.status = upheld ? "Upheld" : "Dismissed";
    o.raisedAt = nowSecs(); // as on-chain: once decided, raised_at is when it was decided
    if (!upheld) return;
    const sn = d.snap();
    const e = est();
    switch (o.kind) {
      case "Claim": {
        const c = sn.claims.find((x) => x.address === o.target);
        if (c) c.status = "Rejected";
        return;
      }
      case "Unlock":
        if (e.status === "Unlocked") return;
        e.status = "Active";
        clearDeath(e);
        return;
      case "Succession": {
        const s = g().seats.find((x) => x.address === o.target);
        if (s) s.succession = null;
        return;
      }
      case "Fallback":
        g().fallbackStartedAt = null;
        return;
      case "Sale": {
        const a = sn.assets.find((x) => x.address === o.target);
        if (!a) return;
        // The listing is cancelled; offers can only be accepted after a fresh listing.
        if (a.status === "Listed") a.status = "Held";
        return;
      }
      case "Hardship": {
        const h = sn.hardships.find((x) => x.address === o.target);
        if (!h) return;
        h.status = "Rejected";
        const a = sn.assets.find((x) => x.address === h.asset);
        if (a && a.hardshipBeneficiary === h.beneficiary) a.hardshipBeneficiary = null;
      }
    }
  }

  function voteObjection(address: Base58, uphold: boolean): TxResult {
    needGuard();
    const o = g().objections.find((x) => x.address === address) ?? fail("BadStatus", "That objection does not exist.");
    need(o.status === "Open", "BadStatus", "This objection has already been decided.");
    need(!lapsed(o), "ObjectionLapsed", "This objection has lapsed: its waiting period is over.");
    const me = d.me();
    const e = est();
    const t = d.tx();
    if (me === e.owner && e.status === "Active") {
      resolve(o, uphold);
      d.log("ObjectionResolved", `${first(me)} ${uphold ? "upheld" : "dismissed"} ${first(o.monitor)}'s objection`, t);
      return t;
    }
    need(me !== o.monitor, "NotVerifier", "You raised this objection, so you cannot vote on it.");
    // `bit` is recorded; a vote at any of the voter's `positions` means they have voted (R9).
    let bit: number;
    let positions: number;
    if (o.kind === "Fallback") {
      // Every trusted person is gone: the monitors decide (bit = seat * 2 + monitor slot).
      positions = g().seats.reduce((all, s) => s.monitors.reduce((m, w, j) => (w === me ? m | (1 << (s.index * 2 + j)) : m), all), 0);
      need(positions !== 0, "NotMonitor", "Only a monitor can decide this.");
      bit = positions & -positions;
    } else {
      const i = e.verifiers.indexOf(me);
      need(i >= 0 && me !== VACANT_KEY, "NotVerifier", "Only a trusted person or the owner can decide this.");
      need(o.seatIndex === null || i !== o.seatIndex, "NotVerifier", "The person being watched cannot vote on this.");
      bit = positions = 1 << i;
    }
    need(((o.votesUphold | o.votesDismiss) & positions) === 0, "AlreadyApproved", "You have already voted.");
    if (!uphold) need(me !== interested(o.kind, o.target), "OwnApproval", "You cannot dismiss a challenge in your own favour.");
    o[uphold ? "votesUphold" : "votesDismiss"] |= bit;
    const n = bitCount(countedVotes(o, uphold ? o.votesUphold : o.votesDismiss));
    d.log("ObjectionVoted", `${first(me)} voted to ${uphold ? "uphold" : "dismiss"} the objection (${n} of 2)`, t);
    if (n >= 2) {
      resolve(o, uphold);
      d.log("ObjectionResolved", uphold ? "The objection was upheld. The paused step was cancelled" : "The objection was dismissed. The paused step can go ahead", d.tx());
    }
    return t;
  }

  /* ----- fallback plan ----- */

  const reports = () => (g().fallbackReports ??= {});
  const livingRecipient = (i: number) => !!g().fallback[i] && !g().fallbackDead[i];
  const nextRecipient = (from = 0) => g().fallback.findIndex((_r, k) => k >= from && !g().fallbackDead[k]);
  const isFallbackParticipant = (who: Base58) => who !== est().agent
    && (isParticipant(who, null) || isMonitorOfAny(who) || g().fallback.some((r, k) => r.wallet === who && livingRecipient(k)));

  /** report_fallback_death + review_fallback_death: the agent only sets the verdict, never the dead bit (R4). */
  function reportFallbackDeath(i: number, certHash: string, report: AgentReport | null): TxResult {
    needGuard();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    const r = g().fallback[i] ?? fail("NoFallbackRecipient", "That fallback recipient does not exist.");
    need(livingRecipient(i), "BadStatus", "This passing is already recorded.");
    const who = d.me();
    need(who !== r.wallet && isFallbackParticipant(who), "NotParticipant", "Only someone else in this estate's plan can report this.");
    const prev = reports()[i];
    if (prev && prev.recipient === r.wallet) {
      need(nowSecs() >= replaceableAt({
        verdict: prev.verdict, reportedAt: prev.reportedAt, reporter: prev.reporter, who,
        waitingSecs: est().waitingPeriodSecs, hold: 2 * refuteWait(g().fallbackWaitSecs),
        grace: fallbackGrace(est().waitingPeriodSecs, g().fallbackWaitSecs),
      }), "BadStatus", "A report about this person is already open.");
    }
    const t = d.tx();
    d.log("FallbackDeathReported", `${first(who)} reported that ${r.name} has passed away`, t);
    delete reports()[i];
    if (report && report.verdict !== "approve") {
      d.log("FallbackDeathReviewed", "The agent could not accept the certificate. Nothing has changed", d.tx());
      return t;
    }
    reports()[i] = { recipient: r.wallet, reporter: who, certHash, verdict: report ? "Approved" : "Pending", report: report ?? undefined, reportedAt: nowSecs() };
    if (report) d.log("FallbackDeathReviewed", `The agent checked the certificate. ${r.name} can say "I'm alive", and a second person must confirm after the wait`, d.tx());
    return t;
  }

  /** resolve_fallback_death: a second participant confirms after the wait, or the person says "I'm alive" any time before. */
  function resolveFallbackDeath(i: number, dead: boolean): TxResult {
    needGuard();
    const rep = reports()[i] ?? fail("BadStatus", "Nobody has reported this person's passing.");
    const who = d.me();
    if (!dead) {
      need(who === rep.recipient, "NotParticipant", "Only the person reported can say they are alive.");
      delete reports()[i];
      const t = d.tx();
      d.log("FallbackDeathRefuted", `${first(who)} said "I'm alive". The report was cancelled`, t);
      return t;
    }
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    need(livingRecipient(i), "BadStatus", "This passing is already recorded.");
    const r = g().fallback[i];
    need(rep.recipient === r.wallet, "NoFallbackRecipient", "The owner has put someone else in this place since the report.");
    need(rep.verdict === "Approved", "AgentNotApproved", "The agent has not cleared the certificate.");
    const gains = g().fallback[nextRecipient(i + 1)]?.wallet;
    need(who !== rep.recipient && who !== rep.reporter && who !== gains && isFallbackParticipant(who),
      "NotConfirmer", "A second person must confirm: not whoever reported it, or who would be paid instead.");
    need(nowSecs() >= rep.reportedAt + refuteWait(g().fallbackWaitSecs), "WaitingPeriodNotOver", "The person reported still has time to say they are alive.");
    const running = countdownValid();
    g().fallbackDead[i] = true;
    // The recipient changed: restart a running countdown so the family can object to the new one.
    if (running) g().fallbackStartedAt = nowSecs();
    delete reports()[i];
    const t = d.tx();
    d.log("FallbackDeathConfirmed", `${first(who)} confirmed that ${r.name} has passed away. The fallback plan skips them`, t);
    return t;
  }

  /** An approved report on whoever is paid next holds the payment, for a bounded time. */
  function heldByReport(i: number, before = Infinity): boolean {
    const r = reports()[i];
    return !!r && r.recipient === g().fallback[i]?.wallet && r.verdict === "Approved" && r.reportedAt < before
      && nowSecs() < r.reportedAt + 2 * refuteWait(g().fallbackWaitSecs);
  }

  /** sweep_residual's fallback route (R20): who it pays, unless a reported death holds it. */
  function sweepRecipient(): Base58 | null {
    const i = g().enabled ? nextRecipient() : -1;
    if (i < 0) return null;
    need(!heldByReport(i), "DeathReportOpen", "This person's passing has been reported, so the payment waits until that is confirmed or refuted.");
    return g().fallback[i].wallet;
  }

  const allSeatsVacant = () => g().seats.length === 3 && g().seats.every((s) => s.vacant && !s.holder);
  /** The countdown still runs: started for this death, and the owner has shown no life since. */
  function countdownValid() {
    const at = g().fallbackStartedAt;
    return !!at && est().lastHeartbeat < at && deathSince(est()) <= at;
  }
  const ownerDeathProven = () => est().status === "Unlocked" || openToPeople(est().death.verdict);
  /** A death the agent only referred, with no trusted people to decide it, waits twice as long (R7). */
  const fallbackDelay = () => g().fallbackWaitSecs * (est().status === "Active" && est().death.verdict === "Referred" ? 2 : 1);

  function startFallback(): TxResult {
    needGuard();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    need(!countdownValid(), "BadStatus", "The fallback plan has already started.");
    need(allSeatsVacant(), "SeatsNotVacant", "A trusted person is still available, so the fallback plan cannot start.");
    need(ownerDeathProven(), "FallbackNotReady", "The owner's passing has not been proven.");
    need(nextRecipient() >= 0, "NoFallbackRecipient", "Every fallback recipient has passed away.");
    g().fallbackStartedAt = nowSecs();
    const t = d.tx();
    d.log("FallbackStarted", "All trusted people are gone. The fallback plan has started its waiting period", t);
    return t;
  }

  function executeFallback(): TxResult {
    needGuard();
    need(!g().fallbackDone, "FallbackDone", "The fallback plan has already been paid out.");
    const started = g().fallbackStartedAt ?? fail("FallbackNotReady", "The fallback plan has not started.");
    need(countdownValid(), "FallbackNotReady", "The owner checked in, or a new death claim was made, after the plan started.");
    need(ownerDeathProven(), "FallbackNotReady", "The owner's passing has not been proven.");
    need(allSeatsVacant(), "SeatsNotVacant", "A trusted person is available again.");
    const runsAt = started + fallbackDelay();
    need(nowSecs() >= runsAt, "WaitingPeriodNotOver", "The waiting period has not ended yet.");
    const fo = openObjection(g().address);
    need(!fo || lapsed(fo), "ObjectionOpen", "Someone objected. This waits until the objection is decided.");
    const i = nextRecipient();
    need(i >= 0, "NoFallbackRecipient", "Every fallback recipient has passed away.");
    need(!heldByReport(i, runsAt), "DeathReportOpen", "This person's passing has been reported, so the payment waits until that is confirmed or refuted.");
    if (fo) markLapsed(fo); // a lapsed objection is closed in the same step, then the payout runs
    const r = g().fallback[i];
    const e = est();
    const amount = e.vaultBalance;
    e.vaultBalance = 0n;
    d.credit(r.wallet, amount);
    g().fallbackDone = true;
    if (e.status === "Active") e.death.pendingSince = nowSecs();
    e.status = "Unlocked";
    const t = d.tx();
    d.log("FallbackExecuted", `Fallback plan: the whole vault (${d.usd(amount)}) went to ${r.name}`, t, amount, { payee: r.wallet });
    return t;
  }

  /** Anyone: closes an Open Fallback objection that was not upheld in time. The countdown is not restarted. */
  function lapseObjection(): TxResult {
    needGuard();
    const o = openObjection(g().address) ?? fail("BadStatus", "There is no open objection to the fallback plan.");
    need(lapsed(o), "ObjectionNotLapsed", "This objection cannot lapse yet.");
    const t = d.tx();
    markLapsed(o);
    return t;
  }

  /* ----- asset photos ----- */

  /**
   * `checked`: the spec sheet already run through specInputSchema by the caller (the service, which loads zod only
   * then). Without it the sheet is taken as given: the seeded demo assets, whose sheets the tests validate.
   */
  function setAssetMedia(asset: Base58, input: { kind: AssetKind; title: string; photos: AssetPhoto[]; description?: string; spec?: AssetSpec }, photosRoot: string, checked?: { success: boolean; data?: AssetSpec }): TxResult {
    needCreated();
    const me = d.me();
    need(me === est().owner && est().status === "Active", "NotOwner", "Only the owner, while the estate is active, can change what buyers see.");
    const a = d.snap().assets.find((x) => x.address === asset) ?? fail("BadStatus", "That asset does not exist.");
    need(input.photos.length <= MAX_PHOTOS, "InvalidAmount", `Add at most ${MAX_PHOTOS} photos.`);
    // Off-chain checks the photo API makes (the program only sees the root): known labels, a valid spec sheet.
    need(input.photos.every((p) => p.label === undefined || isPhotoLabel(p.label)), "InvalidSpec", "Every photo label must be one of the listed ones.");
    need(!checked || checked.success, "InvalidSpec", "Some details in the spec sheet are not valid.");
    const spec = cleanSpec(checked ? (checked.success ? checked.data : undefined) : input.spec);
    need(foreignSpecKeys(input.kind, spec).length === 0, "InvalidSpec", "Some details do not belong on this kind of asset.");
    g().media[asset] = {
      kind: input.kind, title: input.title || a.title, ...(input.description ? { description: input.description } : {}),
      photos: input.photos.map((p) => ({ ...p })), ...(spec ? { spec } : {}), photosRoot, updatedAt: nowSecs(),
    };
    const t = d.tx();
    d.log("AssetMediaSet", `${input.photos.length} photo${input.photos.length === 1 ? "" : "s"} saved for ${input.title || a.title}`, t);
    return t;
  }

  function assetMedia(): AssetMediaInfo[] {
    return Object.entries(g().media).map(([asset, m]) => ({ asset, ...structuredClone(m) }));
  }

  /* ----- reads ----- */

  function snapshot(): GuardiansSnapshot {
    const gs = g();
    if (!gs.enabled) {
      return {
        enabled: false, ...GUARD_DEMO_TIMINGS, seats: [], feed: [], objections: [], claimPayableAt: {},
        fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
      };
    }
    return {
      enabled: true, address: gs.address,
      objectionWindowSecs: gs.objectionWindowSecs, successionWaitSecs: successionWait(), fallbackWaitSecs: gs.fallbackWaitSecs,
      seats: gs.seats.map((s) => ({
        address: s.address, index: s.index, holder: s.holder, holderName: s.holder ? name(s.holder) : "",
        backups: s.backups.map(named), monitors: s.monitors.map(named), generation: s.generation, vacant: s.vacant,
        succession: s.succession ? {
          certHash: s.succession.certHash, reportedBy: s.succession.reportedBy, verdict: s.succession.verdict,
          report: s.succession.report ? structuredClone(s.succession.report) : undefined,
          confirmedBy: s.succession.confirmedBy, reportedAt: s.succession.reportedAt ?? 0, pendingSince: s.succession.pendingSince,
          readyAt: s.succession.pendingSince ? s.succession.pendingSince + successionWait() : 0,
          nextHolder: promotedNext(s),
        } : null,
      })),
      feed: gs.feed.map((f) => ({ ...f })),
      claimPayableAt: Object.fromEntries(d.snap().claims.flatMap((c) => {
        const at = payableAt(c.address);
        return at !== null && countsFor(c) ? [[c.address, at] as const] : [];
      })),
      objections: gs.objections.map((o) => ({
        address: o.address, kind: o.kind, target: o.target, monitor: o.monitor, monitorName: name(o.monitor), seatIndex: o.seatIndex,
        reason: o.reason, reasonHash: o.reasonHash, raisedAt: o.raisedAt, status: o.status,
        votesUphold: bitCount(countedVotes(o, o.votesUphold)), votesDismiss: bitCount(countedVotes(o, o.votesDismiss)), lapsesAt: lapsesAt(o),
        ...(o.keepsSaleCutoff ? { keepsSaleCutoff: true } : {}),
      })),
      fallback: {
        recipients: gs.fallback.map((r, i) => {
          const rep = gs.fallbackReports?.[i];
          return {
            wallet: r.wallet, name: r.name, kind: r.kind, dead: !!gs.fallbackDead[i],
            report: rep && rep.recipient === r.wallet && !gs.fallbackDead[i] ? {
              reporter: rep.reporter, certHash: rep.certHash, verdict: rep.verdict, reportedAt: rep.reportedAt,
              confirmableAt: rep.reportedAt + refuteWait(gs.fallbackWaitSecs), report: rep.report ? structuredClone(rep.report) : undefined,
            } : null,
          };
        }),
        // A voided countdown isn't running: anyone may start it again.
        startedAt: countdownValid() || gs.fallbackDone ? gs.fallbackStartedAt : null,
        readyAt: countdownValid() || gs.fallbackDone ? gs.fallbackStartedAt! + fallbackDelay() : null,
        done: gs.fallbackDone,
        canStart: !countdownValid() && !gs.fallbackDone && nextRecipient() >= 0 && allSeatsVacant() && ownerDeathProven(),
      },
    };
  }

  /* ----- demo clock helpers (mock shortcuts) ----- */

  function endObjectionWindow() {
    const back = g().objectionWindowSecs;
    // A claim decided alone has twice the window: it ends too.
    const lone = (target: Base58) => !!d.snap().claims.find((c) => c.address === target)?.decidedAlone;
    for (const [target, st] of Object.entries(g().stamps)) {
      if (!st.approvedAt) continue;
      st.givenAt ??= st.approvedAt;
      st.approvedAt -= back * (lone(target) ? 2 : 1);
      st.windowEnded = true;
    }
    for (const f of g().feed) if (f.objectionDeadline !== null) f.objectionDeadline -= back * (lone(f.target) ? 2 : 1);
  }
  function endSuccessionWait() {
    for (const s of g().seats) {
      if (!s.succession?.pendingSince) continue;
      s.succession.confirmedAt ??= s.succession.pendingSince;
      s.succession.pendingSince -= successionWait();
    }
  }
  function endFallbackWait() {
    // The same time passes for reports, so a second person can confirm them.
    const refute = refuteWait(g().fallbackWaitSecs);
    for (const r of Object.values(g().fallbackReports ?? {})) r.reportedAt -= refute;
    const started = g().fallbackStartedAt;
    if (started === null) return;
    const back = fallbackDelay();
    const moved = started - back;
    g().fallbackStartedAt = moved;
    // The same time passes for fallback objections (so they can lapse).
    for (const o of g().objections) if (o.kind === "Fallback") o.raisedAt -= back;
    // Moving the clock must not make an earlier check-in or death look as if it came after the start.
    const e = est();
    if (e.lastHeartbeat < started) e.lastHeartbeat = Math.min(e.lastHeartbeat, moved - 1);
    if (deathSince(e) <= started) {
      if (e.status === "Active" && e.death.certHash) e.death.submittedAt = Math.min(e.death.submittedAt ?? 0, moved);
      else if (e.death.pendingSince !== null) e.death.pendingSince = Math.min(e.death.pendingSince, moved);
    }
  }
  /** Every holder and backup gone (demo of the fallback plan). */
  function vacateAllSeats() {
    needGuard();
    const e = est();
    for (const s of g().seats) {
      if (s.vacant) continue;
      s.holder = null; s.vacant = true; s.backups = []; s.succession = null; s.generation += 1;
      e.verifiers[s.index] = VACANT_KEY;
    }
    d.log("SeatVacated", "Demo: every trusted person and backup is recorded as passed away", d.tx());
  }

  return {
    setup, setBackups, setMonitors, setFallback, replaceSeat,
    recordApproval, recordStamp, recordHardshipStamp, saleTiming, livingListed, clearAgentReviews, isBackup,
    countsFor, checkClaimExecutable, checkNotObjected, objectionBinds,
    reportSeatDeath, confirmSeatDeath, vetoSeatDeath, finalizeSuccession,
    raiseObjection, voteObjection,
    reportFallbackDeath, resolveFallbackDeath, sweepRecipient, startFallback, executeFallback, lapseObjection,
    setAssetMedia, assetMedia, snapshot,
    endObjectionWindow, endSuccessionWait, endFallbackWait, vacateAllSeats,
    otherLivingHolders, seat,
  };
}

export type MockGuardians = ReturnType<typeof createMockGuardians>;
