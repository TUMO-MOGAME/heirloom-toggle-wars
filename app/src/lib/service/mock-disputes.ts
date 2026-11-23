/**
 * Mock twin of the program's disputes (U9) and yearly caps (docs/program-spec.md, "Disputes and yearly caps"):
 * the same checks and error names, so the demo and devnet sites behave the same.
 *
 * Disputes live in `snap.disputes` and rules carry `yearlyCap`, so both persist with the rest of the mock state.
 * mock.ts calls the hooks (checkNotDisputed, checkYearly, checkObjectionAllowed) from its existing instructions.
 */
import type { Base58, Rule } from "../types";
import type { EstateSnapshot, TxResult } from "./types";
import type { ObjectionStatus, TargetKind } from "../guardians/types";
import { currentPeriod, disputeLapsesAt, effectiveStatus, YEAR_SECS, type Dispute, type DisputeKind } from "../disputes/types";
import { fail, need } from "./mock-errors";
import { shortName } from "../names";
import { eligibleSeats } from "../death-rules";
import { deathSince, interestedIn } from "../guardians/decisions";
import { clearDeath } from "./mock-rules";

/** Stored with which seats voted to uphold, so the vote of a seat that emptied stops counting. */
type MockDispute = Dispute & { votedUp?: number[] };

export interface DisputeDeps {
  snap(): EstateSnapshot;
  names(): Record<Base58, string>;
  created(): boolean;
  me(): Base58;
  now(): number;
  tx(): TxResult;
  log(kind: string, text: string, t: TxResult, amount?: bigint): void;
  usd(amount: bigint): string;
  /** Monitors' objections (mock-guardians): a target has an objection or a dispute, never both at once. */
  objections(): { target: Base58; kind: TargetKind; status: ObjectionStatus; raisedAt: number }[];
  /** True if the address is an Open, not lapsed, monitor objection target. */
  objectionOpen(target: Base58): boolean;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeAddr = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join("");


export function createMockDisputes(d: DisputeDeps) {
  const est = () => d.snap().estate;
  const list = (): MockDispute[] => (d.snap().disputes ??= []);
  const name = (a: Base58) => d.names()[a] ?? "Someone";
  // The short form used in sentences everywhere (lib/names): "Lerato Mokoena" → "Lerato", "Adv. Thandi Ndlovu" → "Adv. Ndlovu".
  const first = (a: Base58) => shortName(name(a));
  const needCreated = () => need(d.created(), "NoEstate", "There is no estate yet. The owner signs the will first.");
  const latestOn = (target: Base58) => list().filter((x) => x.target === target).sort((a, b) => b.raisedAt - a.raisedAt)[0];
  /** The owner showed life after it was raised: the death it challenged is void. */
  const voidedByOwner = (x: Dispute) => x.kind === "Unlock" && x.raisedAt < est().lastHeartbeat;
  const isOpen = (x: Dispute | undefined) => !!x && effectiveStatus(x, d.now()) === "Open" && !voidedByOwner(x);
  /** Votes that count: seats someone still holds. An older saved dispute only has the totals. */
  function votes(x: MockDispute): { up: number; down: number } {
    const { votedUp } = x;
    if (!votedUp) return { up: x.votesUphold, down: x.votesDismiss };
    const counted = eligibleSeats(est().verifiers).filter((i) => x.voted.includes(i));
    const up = counted.filter((i) => votedUp.includes(i)).length;
    return { up, down: counted.length - up };
  }
  const latest = (target: Base58) => latestOn(target) ?? null;
  /** getEstate: what the program would act on. */
  function snapshot(): Dispute[] {
    return list().map((stored) => {
      const v = votes(stored);
      const shown: MockDispute = {
        ...stored, voted: [...stored.voted], votesUphold: v.up, votesDismiss: v.down,
        lapsesAt: stored.status === "Open" && voidedByOwner(stored) ? Math.min(stored.lapsesAt, est().lastHeartbeat) : stored.lapsesAt,
      };
      delete shown.votedUp;
      return shown;
    });
  }

  /** execute_claim / finalize_unlock: an open (not lapsed) dispute pauses the action. */
  function checkNotDisputed(target: Base58) {
    need(!isOpen(latestOn(target)), "ObjectionOpen", "A dispute is open, so this is paused until the trusted people decide.");
  }

  /** raise_objection on a target with a dispute: only an open one blocks it; a finished one never uses it up. */
  function checkObjectionAllowed(_kind: TargetKind, target: Base58) {
    const x = latestOn(target);
    if (!x) return;
    need(!isOpen(x), "ObjectionOpen", "A dispute is already open on this.");
  }

  function raiseDispute(kind: DisputeKind, target: Base58, reason: string, reasonHash: string): TxResult {
    needCreated();
    const me = d.me();
    const e = est();
    const isVerifier = e.verifiers.includes(me);
    const isBeneficiary = d.snap().beneficiaries.some((b) => b.wallet === me && b.active);
    need(isVerifier || isBeneficiary, "NotDisputer", "Only a family member or a trusted person can dispute.");
    need(reason.trim().length > 0, "InvalidAmount", "Write a short reason.");
    let what = "";
    if (kind === "Claim") {
      const c = d.snap().claims.find((x) => x.address === target) ?? fail("BadStatus", "That claim does not exist.");
      need(c.status === "Open", "BadStatus", "This claim is no longer pending.");
      need(c.beneficiary !== me, "OwnClaimDispute", "You cannot dispute your own claim.");
      what = `${d.usd(c.amount)} to ${name(c.payee)} for ${first(c.beneficiary)}`;
    } else if (kind === "Unlock") {
      need(target === e.address, "BadStatus", "That is not this estate.");
      need(e.status === "DeathPending", "BadStatus", "Only a pending unlock (during the waiting period) can be disputed.");
      need(me !== e.death.submittedBy, "OwnClaimDispute", "You reported this passing, so you cannot dispute its unlock.");
      what = `the unlock of ${first(e.owner)}'s estate`;
    } else {
      fail("BadStatus", "Only claims and the unlock can be disputed.");
    }
    // Same PDA as a monitor's objection.
    need(!d.objectionOpen(target), "ObjectionOpen", "An objection is already open on this.");
    const roundStart = deathSince(e);
    const prevObjection = d.objections().filter((o) => o.target === target).sort((a, b) => b.raisedAt - a.raisedAt)[0];
    const prev = latestOn(target);
    need(!isOpen(prev), "ObjectionOpen", "A dispute is already open on this.");
    const prevAt = Math.max(prev?.raisedAt ?? -1, prevObjection?.raisedAt ?? -1);
    if (prevAt >= 0) {
      if (kind === "Claim") fail("BadStatus", "This payment has already been challenged once.");
      const last = prev && prev.raisedAt === prevAt ? prev.status : prevObjection!.status;
      need(last === "Upheld" || prevAt < roundStart, "BadStatus", "This waiting period has already been disputed once.");
    }
    const raisedAt = d.now();
    list().unshift({
      address: fakeAddr(), kind, target, disputer: me, disputerName: name(me), reason: reason.trim(), reasonHash,
      raisedAt, lapsesAt: disputeLapsesAt(raisedAt, e.waitingPeriodSecs), status: "Open", votesUphold: 0, votesDismiss: 0, voted: [], votedUp: [],
    });
    const t = d.tx();
    d.log("DisputeRaised", `${name(me)} disputed ${what}. It is paused until two trusted people decide`, t);
    return t;
  }

  function resolveDispute(address: Base58, uphold: boolean): TxResult {
    needCreated();
    const x = list().find((y) => y.address === address) ?? fail("BadStatus", "That dispute does not exist.");
    need(x.status === "Open", "BadStatus", "This dispute has already been decided.");
    need(isOpen(x), "DisputeLapsed", "This dispute has lapsed: its time to resolve it is over.");
    const me = d.me();
    const i = est().verifiers.indexOf(me);
    need(i >= 0, "NotVerifier", "Only one of the three trusted people can do this.");
    need(me !== x.disputer, "NotVerifier", "The person who raised the dispute cannot decide it.");
    need(!x.voted.includes(i), "AlreadyApproved", "You have already voted on this.");
    if (!uphold) need(me !== interestedIn(d.snap(), x.kind, x.target), "OwnApproval", "You cannot dismiss a dispute in your own favour.");
    x.voted.push(i);
    if (uphold) { x.votesUphold += 1; x.votedUp?.push(i); } else x.votesDismiss += 1;
    const t = d.tx();
    d.log("DisputeVoted", `${name(me)} voted to ${uphold ? "uphold" : "dismiss"} the dispute`, t);
    const { up, down } = votes(x);
    if (up < 2 && down < 2) return t;
    const upheld = up >= 2;
    x.status = upheld ? "Upheld" : "Dismissed";
    // As on-chain: once decided, raised_at is when it was decided (a claim's objection window runs from there).
    x.raisedAt = d.now();
    x.lapsesAt = disputeLapsesAt(x.raisedAt, est().waitingPeriodSecs);
    if (upheld && x.kind === "Claim") {
      const c = d.snap().claims.find((y) => y.address === x.target);
      if (c && c.status === "Open") c.status = "Rejected";
    }
    if (upheld && x.kind === "Unlock") {
      const e = est();
      if (e.status !== "Unlocked") {
        e.status = "Active";
        clearDeath(e);
      }
    }
    d.log("DisputeResolved", upheld
      ? x.kind === "Claim" ? "Dispute upheld: the payment was cancelled" : "Dispute upheld: the unlock was stopped and the vault stays locked"
      : "Dispute dismissed: the paused action can go ahead", d.tx());
    return t;
  }

  /* ----- yearly caps ----- */

  function setYearlyCap(ruleAddr: Base58, capUsdtBase: bigint, periodStart?: number): TxResult {
    needCreated();
    need(d.me() === est().owner, "NotOwner", "Only the estate owner can do this.");
    need(est().status === "Active", "BadStatus", "Limits can only change while the estate is active.");
    const r = d.snap().rules.find((x) => x.address === ruleAddr) ?? fail("BadStatus", "That rule does not exist.");
    need(capUsdtBase > 0n && capUsdtBase <= r.lifetimeCap && capUsdtBase >= r.recurringAmount, "InvalidAmount",
      "The yearly limit must be above zero, no more than the rule's total and at least one scheduled payment.");
    const now = d.now();
    need(periodStart === undefined || (periodStart >= 0 && periodStart <= now), "InvalidAmount", "The year cannot start in the future.");
    const start = periodStart ?? (r.yearlyCap?.periodStart ?? now);
    const spent = r.yearlyCap?.spent ?? 0n;
    r.yearlyCap = { cap: capUsdtBase, periodStart: start, periodEnd: start + YEAR_SECS, spent };
    const t = d.tx();
    d.log("YearlyCapSet", `${first(d.me())} set a yearly limit of ${d.usd(capUsdtBase)} on this rule`, t);
    return t;
  }

  /** submit_claim (record = false), execute_claim and execute_scheduled (record = true). */
  function checkYearly(r: Rule, amount: bigint, record: boolean) {
    const y = r.yearlyCap;
    if (!y) return;
    const p = currentPeriod(y.cap, y.periodStart, y.spent, d.now());
    need(p.spent + amount <= p.cap, "ExceedsYearlyCap",
      `This rule pays at most ${d.usd(p.cap)} a year; ${d.usd(p.cap > p.spent ? p.cap - p.spent : 0n)} is left this year.`);
    if (record) r.yearlyCap = { ...p, spent: p.spent + amount };
  }

  return { raiseDispute, resolveDispute, latest, snapshot, checkNotDisputed, checkObjectionAllowed, setYearlyCap, checkYearly };
}
