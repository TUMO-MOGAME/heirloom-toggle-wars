/**
 * The second security review's changed meanings on the read side (docs/program-spec.md), from real IDL encodings:
 * times, claims of replaced rules, approvals from before a death, reports that can be replaced, agent votes, events.
 */
import { describe, expect, it } from "vitest";
import { BN, EventParser } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getCoder, getIdl } from "./idl";
import { decodeAgentVotes, decodeClaim, decodeEstate, decodeRule, withClaimState, type Raw } from "./decoders";
import { assembleGuardians, fallbackSlot, nextFallback, type RawGuardians } from "./guardians";
import { decodeDispute } from "./disputes";
import { describeEvent } from "./events";
import { activityFrom, deathReviewHash, standingReviewHash, type ChainEvent } from "./reads";
import { unlockWaitSecs } from "../death-rules";
import { assembleSnapshot } from "./snapshot";
import type { Claim, Estate } from "../types";

const k = () => Keypair.generate().publicKey;
const D = PublicKey.default;
const [owner, agent, estateKey, ruleKey, heir, reporter, confirmer, backup] = Array.from({ length: 8 }, k);
const v = [k(), k(), k()];
const bn = (n: number) => new BN(String(n));
const bytes = (n: number) => Array<number>(32).fill(n);
const roundTrip = async (type: string, raw: Record<string, unknown>) =>
  getCoder().accounts.decode(type, await getCoder().accounts.encode(type, raw)) as Raw;

async function estateOf(over: Record<string, unknown> = {}): Promise<Estate> {
  return decodeEstate(estateKey.toBase58(), await roundTrip("Estate", {
    owner, agent, usdt_mint: k(), verifiers: v, death_threshold: 2, claim_threshold: 1, hardship_threshold: 2,
    waiting_period_secs: bn(120), status: { Active: {} }, will_hash: bytes(1), will_uri: "x", death_cert_hash: bytes(0),
    death_submitted_by: D, death_verdict: { Pending: {} }, death_attestations: 0, death_pending_since: bn(0),
    last_heartbeat: bn(0), rule_count: 1, bump: 255, ...over,
  }), 0n);
}

async function claimOf(id: number, over: Record<string, unknown> = {}): Promise<Claim> {
  return decodeClaim(k().toBase58(), await roundTrip("Claim", {
    estate: estateKey, rule: ruleKey, id, beneficiary: heir, payee: k(), amount: bn(5), evidence_hash: bytes(2),
    agent_verdict: { Approved: {} }, agent_report_hash: bytes(0), approvals: 0, status: { Open: {} }, created_at: bn(500),
    owner_approved: false, bump: 1, ...over,
  }));
}

const stampOf = (approvedAt: number, seatIndex: number, target: PublicKey = k()) =>
  roundTrip("ApprovalStamp", { target, seat_index: seatIndex, approver: v[0], approved_at: bn(approvedAt), bump: 1 });

describe("death_pending_since has two meanings", () => {
  it("Active with a claim: the submission time, never a running wait", async () => {
    const e = await estateOf({ death_cert_hash: bytes(7), death_submitted_by: heir, death_pending_since: bn(900) });
    expect(e.death).toMatchObject({ pendingSince: null, submittedAt: 900 });
  });
  it("a claim from before times were stored reads as 0", async () => {
    expect((await estateOf({ death_cert_hash: bytes(7) })).death).toMatchObject({ pendingSince: null, submittedAt: 0 });
  });
  it("Active without a claim: neither", async () => {
    expect((await estateOf({ death_pending_since: bn(900) })).death).toMatchObject({ pendingSince: null, submittedAt: null });
  });
  it.each(["DeathPending", "Unlocked"])("%s: when the death took effect", async (status) => {
    const e = await estateOf({ status: { [status]: {} }, death_cert_hash: bytes(7), death_pending_since: bn(900) });
    expect(e.death).toMatchObject({ pendingSince: 900, submittedAt: null });
  });
});

describe("claims", () => {
  const ruleWith = async (claimCount: number) => decodeRule(ruleKey.toBase58(), await roundTrip("Rule", {
    estate: estateKey, id: 0, beneficiary: heir, category: { Books: {} }, allowed_payee_kind: { School: {} }, max_per_claim: bn(5),
    lifetime_cap: bn(50), spent_total: bn(0), valid_until: bn(9_999), claim_count: claimCount, starts_now: true,
    recurring_amount: bn(0), interval_secs: bn(0), next_due: bn(0), fixed_payee: D, bump: 1,
  }));

  it("a reused slot: claimCount, and the earlier rule's claims are marked", async () => {
    const rule = await ruleWith(65_537);
    expect(rule.claimCount).toBe(65_537);
    const estate = await estateOf();
    expect(withClaimState(await claimOf(3), { estate, rule }).fromEndedRule).toBe(true);
    expect(withClaimState(await claimOf(65_536), { estate, rule }).fromEndedRule).toBe(false);
  });

  it("approvals count only once Unlocked, and only from after this death", async () => {
    const unlocked = await estateOf({ status: { Unlocked: {} }, death_cert_hash: bytes(7), death_pending_since: bn(1_000) });
    const signed = await claimOf(0, { approvals: 1 });
    const counts = async (estate: Estate, claim: Claim, stamp?: Raw) => withClaimState(claim, { estate, stamp }).approvalsCount;

    expect(await counts(await estateOf(), signed, await stampOf(400, 0))).toBe(false);
    expect(await counts(unlocked, signed)).toBe(false);
    expect(await counts(unlocked, signed, await stampOf(999, 0))).toBe(false);
    expect(await counts(unlocked, signed, await stampOf(1_000, 0))).toBe(true);
    expect(await counts(unlocked, signed, await stampOf(0, 255))).toBe(true); // being collected since the unlock
    expect(await counts(unlocked, signed, await stampOf(0, 0))).toBe(false); // collected by the older program
    expect(await counts(unlocked, await claimOf(0, { approvals: 1, created_at: bn(1_001) }))).toBe(true);
    expect(await counts(await estateOf(), await claimOf(0))).toBe(true); // none given: nothing to discount
  });
});

describe("agent votes", () => {
  it("only votes against the agent of today, by whoever still holds that seat", async () => {
    const candidate = k();
    const vote = (over: Record<string, unknown>) =>
      roundTrip("AgentVote", { estate: estateKey, candidate, replaces: agent, voters: [v[0], k(), D], bump: 1, ...over });
    const estate = await estateOf();
    expect(decodeAgentVotes([
      await vote({}), await vote({ replaces: k() }), await vote({ candidate: k(), voters: [D, D, D] }),
    ], estate)).toEqual([{ candidate: candidate.toBase58(), voters: [v[0].toBase58()] }]);
  });

  it("reach the snapshot", async () => {
    const agentVotes = [{ candidate: "C", voters: ["V"] }];
    const snap = assembleSnapshot({
      estate: await estateOf(), ruleCount: 0, beneficiaries: [], payees: [], rules: [], claims: [], assets: [], offers: [],
      hardships: [], agentVotes, reportHashes: {},
    }, [], {});
    expect(snap.agentVotes).toEqual(agentVotes);
  });
});

const seatRaw = (index: number, over: Record<string, unknown> = {}) => roundTrip("Seat", {
  estate: estateKey, index, holder: v[index], backups: [D, D], monitors: [D, D], generation: 0, vacant: false,
  death_cert_hash: bytes(0), death_reported_by: D, death_verdict: { Pending: {} }, death_confirmed_by: D,
  death_pending_since: bn(0), bump: 1, ...over,
});
const vacantSeat = (index: number) => seatRaw(index, { holder: D, vacant: true });
const guardRaw = (over: Record<string, unknown> = {}) => roundTrip("Guard", {
  estate: estateKey, objection_window_secs: bn(60), succession_wait_secs: bn(300), fallback_wait_secs: bn(500),
  open_objections: 0, fallback: [heir, D, backup, D], fallback_dead: 0, fallback_started_at: bn(0), fallback_done: false, bump: 1, ...over,
});

async function view(over: Partial<RawGuardians> & { estate?: Estate; claims?: Claim[]; events?: ChainEvent[]; reports?: Record<string, unknown>; guardOver?: Record<string, unknown> } = {}) {
  const { estate, claims, events, reports, guardOver, ...raw } = over;
  return assembleGuardians(
    { guard: { address: "G", raw: await guardRaw(guardOver) }, seats: [], objections: [], stamps: {}, media: {}, ...raw },
    {
      estate: estate ?? (await estateOf()), claims: claims ?? [], events: events ?? [],
      extras: { names: {}, reasons: {}, fallbackKinds: {}, reports: (reports ?? {}) as never },
    },
  );
}

const event = (name: string, ts: number, data: Record<string, unknown> = {}): ChainEvent => ({ name, ts, signature: `s${ts}`, data });

describe("seat death reports", () => {
  it("unconfirmed: the stored time is the report's and no wait runs", async () => {
    const seat = await seatRaw(0, { death_cert_hash: bytes(7), death_reported_by: reporter, death_pending_since: bn(700) });
    const g = await view({ seats: [{ address: "S", raw: seat }] });
    expect(g.seats[0].succession).toMatchObject({ reportedAt: 700, confirmedBy: null, pendingSince: 0, readyAt: 0 });
  });

  it("confirmed: the stored time is the confirmation's; the report's comes from its event", async () => {
    const seat = await seatRaw(0, {
      death_cert_hash: bytes(7), death_reported_by: reporter, death_verdict: { Approved: {} },
      death_confirmed_by: confirmer, death_pending_since: bn(900), backups: [agent, backup],
    });
    const g = await view({ seats: [{ address: "S", raw: seat }], events: [event("SeatDeathReported", 700, { seat_index: 0 })] });
    expect(g.seats[0].succession).toMatchObject({ reportedAt: 700, pendingSince: 900, readyAt: 1_200 });
    expect(g.seats[0].succession!.nextHolder!.wallet).toBe(backup.toBase58()); // never the agent
  });

  it("never shows the review of the report it replaced", async () => {
    const seat = await seatRaw(0, { death_cert_hash: bytes(8), death_reported_by: reporter, death_verdict: { Approved: {} }, death_pending_since: bn(800) });
    const old = event("SeatDeathReviewed", 600, { seat_index: 0, report_hash: bytes(9) });
    const replaced = event("SeatDeathReported", 800, { seat_index: 0 });
    const reports = { ["09".repeat(32)]: { summary: "old" } };
    const seats = [{ address: "S", raw: seat }];
    expect((await view({ seats, reports, events: [replaced, old] })).seats[0].succession!.report).toBeUndefined();
    expect((await view({ seats, reports, events: [old] })).seats[0].succession!.report).toEqual({ summary: "old" });
  });
});

describe("fallback", () => {
  const vacant = async () => Promise.all([0, 1, 2].map(async (i) => ({ address: `S${i}`, raw: await vacantSeat(i) })));
  const dead = (verdict: string, over: Record<string, unknown> = {}) => estateOf({
    verifiers: [D, D, D], death_cert_hash: bytes(7), death_verdict: { [verdict]: {} }, death_pending_since: bn(100), ...over,
  });

  it.each([["Approved", 1_500], ["Referred", 2_000]] as const)("Active and %s: ready at %i", async (verdict, readyAt) => {
    const g = await view({ estate: await dead(verdict), seats: await vacant(), guardOver: { fallback_started_at: bn(1_000) } });
    expect(g.fallback).toMatchObject({ startedAt: 1_000, readyAt, canStart: false });
  });

  it("Unlocked doesn't double the wait, whatever the verdict", async () => {
    const g = await view({ estate: await dead("Referred", { status: { Unlocked: {} } }), seats: await vacant(), guardOver: { fallback_started_at: bn(1_000) } });
    expect(g.fallback.readyAt).toBe(1_500);
  });

  it("a referred death can start it", async () => {
    expect((await view({ estate: await dead("Referred"), seats: await vacant() })).fallback.canStart).toBe(true);
    expect((await view({ estate: await dead("Pending"), seats: await vacant() })).fallback.canStart).toBe(false);
  });

  it.each([
    ["the owner showed life since", { last_heartbeat: bn(1_000) }],
    ["it was for an earlier death claim", { death_pending_since: bn(1_001) }],
  ])("a countdown is void when %s", async (_, over) => {
    const g = await view({ estate: await dead("Approved", over), seats: await vacant(), guardOver: { fallback_started_at: bn(1_000) } });
    expect(g.fallback).toMatchObject({ startedAt: null, readyAt: null, canStart: true });
  });

  it("an open report, by slot, with the time a second person may confirm", async () => {
    const report = (over: Record<string, unknown> = {}) => roundTrip("FallbackReport", {
      estate: estateKey, index: 2, recipient: backup, reporter, rent_payer: reporter, cert_hash: bytes(4),
      verdict: { Approved: {} }, reported_at: bn(2_000), bump: 1, ...over,
    });
    const g = await view({ fallbackReports: [await report()] });
    expect(g.fallback.recipients).toHaveLength(2); // slot 2 is the second on screen
    expect(g.fallback.recipients[0].report).toBeNull();
    expect(g.fallback.recipients[1].report).toEqual({
      reporter: reporter.toBase58(), certHash: "04".repeat(32), verdict: "Approved", reportedAt: 2_000, confirmableAt: 2_500,
    });
    const short = await view({ fallbackReports: [await report()], guardOver: { fallback_wait_secs: bn(0) } });
    expect(short.fallback.recipients[1].report!.confirmableAt).toBe(2_060); // refuting always has a minute
    const void_ = await view({ fallbackReports: [await report({ recipient: k() })] });
    expect(void_.fallback.recipients[1].report).toBeNull();
  });

  it("screen positions map to on-chain slots, and the next recipient to its slot", async () => {
    const g = await guardRaw();
    expect([0, 1, 2].map((i) => fallbackSlot(g, i))).toEqual([0, 2, -1]);
    expect(nextFallback(g)).toEqual({ index: 0, wallet: heir.toBase58() });
    expect(nextFallback(await guardRaw({ fallback_dead: 1 }))).toEqual({ index: 2, wallet: backup.toBase58() });
    expect(nextFallback(await guardRaw({ fallback_dead: 5 }))).toEqual({ index: 255, wallet: null });
    expect(nextFallback(null)).toEqual({ index: 255, wallet: null });
  });
});

describe("claims waiting for the objection window", () => {
  const payable = async (claim: Claim, estate: Estate, objections: RawGuardians["objections"] = []) =>
    (await view({ estate, claims: [claim], objections, stamps: { [claim.address]: await stampOf(2_000, 0, new PublicKey(claim.address)) } })).claimPayableAt![claim.address];

  it("no date when the approvals don't count or the quorum was lost", async () => {
    const unlocked = await estateOf({ status: { Unlocked: {} } });
    const claim = await claimOf(0, { approvals: 1 });
    expect(await payable(claim, unlocked)).toBe(2_060);
    expect(await payable({ ...claim, approvalsCount: false }, unlocked)).toBeUndefined();
    expect(await payable(claim, { ...unlocked, verifiers: [D.toBase58(), v[1].toBase58(), v[2].toBase58()] })).toBeUndefined();
    expect(await payable(claim, { ...unlocked, verifiers: [heir.toBase58(), v[1].toBase58(), v[2].toBase58()] })).toBeUndefined();
  });

  it("the window runs again after a dispute: from its decision once decided (raised_at), else from when it lapses", async () => {
    const claim = await claimOf(0, { approvals: 1 });
    const dispute = (status: Record<string, object>) => roundTrip("Objection", {
      estate: estateKey, target: new PublicKey(claim.address), kind: { Claim: {} }, monitor: v[1], seat_index: 254,
      reason_hash: bytes(1), raised_at: bn(2_010), status, votes_uphold: 0, votes_dismiss: 6, bump: 1,
    });
    const unlocked = await estateOf({ status: { Unlocked: {} } });
    expect(await payable(claim, unlocked, [{ address: "O", raw: await dispute({ Dismissed: {} }) }])).toBe(2_070);
    expect(await payable(claim, unlocked, [{ address: "O", raw: await dispute({ Open: {} }) }])).toBe(2_190);
  });

  it("a claim its claimant approved alone (DECIDED_ALONE) waits twice the window; the bit is no seat's vote", async () => {
    const lone = [heir.toBase58(), D.toBase58(), D.toBase58()] as [string, string, string];
    const claim = await claimOf(0, { approvals: 0b1000_0001 });
    expect([claim.approvals, claim.decidedAlone]).toEqual([[true, false, false], true]);
    expect(await payable(claim, { ...(await estateOf({ status: { Unlocked: {} } })), verifiers: lone })).toBe(2_120);
  });

  it("a death decided alone: flagged, not a seat's vote, and the unlock waits twice", async () => {
    const e = await estateOf({ status: { DeathPending: {} }, death_attestations: 0b1000_0001, death_pending_since: bn(500), death_cert_hash: bytes(3) });
    expect([e.death.attestations, e.death.decidedAlone]).toEqual([[true, false, false], true]);
    expect(unlockWaitSecs(e)).toBe(240);
    expect(unlockWaitSecs({ ...e, death: { ...e.death, decidedAlone: false } })).toBe(120);
  });

  it("a stored waiting period reads as at least a minute", async () => {
    expect((await estateOf({ waiting_period_secs: bn(0) })).waitingPeriodSecs).toBe(60);
    expect((await estateOf({ waiting_period_secs: bn(10 * 365 * 86_400) })).waitingPeriodSecs).toBe(365 * 86_400);
  });
});

describe("challenges", () => {
  const challenge = (seatIndex: number) => roundTrip("Objection", {
    estate: estateKey, target: estateKey, kind: { Unlock: {} }, monitor: reporter, seat_index: seatIndex, reason_hash: bytes(1),
    raised_at: bn(100), status: { Open: {} }, votes_uphold: 0b011, votes_dismiss: 0, bump: 1,
  });

  it("one raised before the owner's sign of life reads as lapsed", async () => {
    const estate = await estateOf({ last_heartbeat: bn(101) });
    const g = await view({ estate, objections: [{ address: "O", raw: await challenge(255) }] });
    expect(g.objections[0].lapsesAt).toBe(100);
    expect(decodeDispute("D", await challenge(254), estate, {}, {}).lapsesAt).toBe(100);
  });

  it("a vacant seat's vote doesn't count", async () => {
    const estate = await estateOf({ verifiers: [v[0], D, v[2]] });
    const g = await view({ estate, objections: [{ address: "O", raw: await challenge(255) }] });
    expect(g.objections[0].votesUphold).toBe(1);
    expect(decodeDispute("D", await challenge(254), estate, {}, {}).votesUphold).toBe(1);
  });
});

describe("events", () => {
  it("every event of the IDL has a line of its own", () => {
    for (const e of getIdl().events!) expect(describeEvent(e.name, {}).text, e.name).not.toBe(e.name);
  });

  it("AgentReviewCleared decodes from the program's log and reads as plain words", () => {
    const def = getIdl().events!.find((e) => e.name === "AgentReviewCleared")!;
    const target = k();
    const log = `Program data: ${Buffer.concat([Buffer.from(def.discriminator), getCoder().types.encode("AgentReviewCleared", { estate: estateKey, target, ts: bn(7) })]).toString("base64")}`;
    const program = getIdl().address;
    const [ev] = [...new EventParser(new PublicKey(program), getCoder()).parseLogs([`Program ${program} invoke [1]`, log, `Program ${program} success`])];
    expect(ev.name).toBe("AgentReviewCleared");
    expect((ev.data as Raw).target).toEqual(target);
    const [line] = activityFrom([{ name: ev.name, data: ev.data as Raw, ts: 7, signature: "s" }]);
    expect(line).toMatchObject({ kind: "AgentReviewCleared", text: expect.stringMatching(/new agent/) });
  });

  it("a report's review never speaks for the report that replaced it", () => {
    const reviewed = event("DeathReviewed", 10, { report_hash: bytes(1) });
    const referred = event("ReviewReferred", 11, { kind: { Unlock: {} }, report_hash: bytes(2) });
    const claimReferred = event("ReviewReferred", 12, { kind: { Claim: {} }, report_hash: bytes(3) });
    const submitted = event("DeathClaimSubmitted", 13);
    expect(deathReviewHash([reviewed], { certHash: "c", verdict: "Approved" })).toBe("01".repeat(32));
    expect(deathReviewHash([claimReferred, referred], { certHash: "c", verdict: "Referred" })).toBe("02".repeat(32));
    expect(deathReviewHash([submitted, reviewed], { certHash: "c", verdict: "Approved" })).toBeUndefined();
    expect(deathReviewHash([reviewed], { certHash: "c", verdict: "Pending" })).toBeUndefined();
    expect(standingReviewHash([], "X", () => true)).toBeUndefined();
  });

  it("a fallback review no longer claims the recipient is skipped", () => {
    expect(describeEvent("FallbackDeathReviewed", { approved: true }).text).toMatch(/second person confirms/);
  });
});
