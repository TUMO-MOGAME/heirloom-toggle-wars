/** Guardians read side: real IDL encode → decode → GuardiansSnapshot (docs/guardians-spec.md §2.1). */
import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getCoder } from "./idl";
import { assembleGuardians, disabledGuardians, type RawGuardians } from "./guardians";
import type { Raw } from "./decoders";
import type { Claim, Estate } from "../types";
import type { ChainEvent } from "./reads";

const k = () => Keypair.generate().publicKey;
const D = PublicKey.default;
const owner = k(), estateKey = k(), v = [k(), k(), k()], kagiso = k(), priya = k(), zodwa = k(), lerato = k(), sipho = k();
const roundTrip = async (type: string, raw: Record<string, unknown>) =>
  getCoder().accounts.decode(type, await getCoder().accounts.encode(type, raw)) as Raw;

const estate: Estate = {
  address: estateKey.toBase58(), owner: owner.toBase58(), ownerName: "Thabo", agent: k().toBase58(), usdtMint: k().toBase58(),
  verifiers: v.map((x) => x.toBase58()) as [string, string, string], verifierNames: ["Ndlovu", "Pillay", "Bongani"],
  deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60, status: "Unlocked", willHash: null, vaultBalance: 0n,
  death: { certHash: null, submittedBy: null, verdict: "Approved", attestations: [true, true, false], pendingSince: null }, lastHeartbeat: 100,
};

const seat = (index: number, extra: Record<string, unknown> = {}) => roundTrip("Seat", {
  estate: estateKey, index, holder: v[index], backups: index === 2 ? [kagiso, priya] : [D, D], monitors: index === 2 ? [zodwa, D] : [D, D],
  generation: 0, vacant: false, death_cert_hash: Array(32).fill(0), death_reported_by: D, death_verdict: { Pending: {} },
  death_confirmed_by: D, death_pending_since: new BN(0), bump: 1, ...extra,
});

describe("assembleGuardians", () => {
  it("no Guard → disabled", () => {
    const raw: RawGuardians = { guard: null, seats: [], objections: [], stamps: {}, media: {} };
    expect(assembleGuardians(raw, { estate, claims: [], events: [], extras: { names: {}, reasons: {}, fallbackKinds: {}, reports: {} } })).toEqual(disabledGuardians());
  });

  it("decodes seats, succession, objections, stamps, the feed and the fallback plan", async () => {
    const claim = k();
    const guard = await roundTrip("Guard", {
      estate: estateKey, objection_window_secs: new BN(60), succession_wait_secs: new BN(60), fallback_wait_secs: new BN(120),
      open_objections: 1, fallback: [lerato, sipho, D, D], fallback_dead: 1, fallback_started_at: new BN(0), fallback_done: false, bump: 1,
    });
    const reasonHash = "cd".repeat(32);
    const objection = await roundTrip("Objection", {
      estate: estateKey, target: claim, kind: { Claim: {} }, monitor: zodwa, seat_index: 2, reason_hash: Array(32).fill(0xcd),
      raised_at: new BN(500), status: { Open: {} }, votes_uphold: 0b001, votes_dismiss: 0, bump: 1,
    });
    const stamp = await roundTrip("ApprovalStamp", { target: claim, seat_index: 2, approver: v[2], approved_at: new BN(400), bump: 1 });
    const raw: RawGuardians = {
      guard: { address: "G", raw: guard },
      seats: [
        { address: "S0", raw: await seat(0) }, { address: "S1", raw: await seat(1) },
        { address: "S2", raw: await seat(2, { death_cert_hash: Array(32).fill(7), death_reported_by: zodwa, death_verdict: { Approved: {} }, death_confirmed_by: v[0], death_pending_since: new BN(900) }) },
      ],
      objections: [{ address: "O", raw: objection }],
      stamps: { [claim.toBase58()]: stamp },
      media: {},
    };
    const c: Claim = {
      address: claim.toBase58(), rule: "R", id: 0, beneficiary: lerato.toBase58(), payee: k().toBase58(), amount: 3_500_000_000n, evidenceHash: "0".repeat(64),
      agentVerdict: "Approved", approvals: [false, false, true], ownerApproved: false, status: "Open", createdAt: 1,
    };
    const events: ChainEvent[] = [{ name: "SeatApproval", ts: 400, signature: "sig", data: { estate: estateKey, seat_index: 2, approver: v[2], kind: { Claim: {} }, target: claim, ts: new BN(400) } }];
    const g = assembleGuardians(raw, {
      estate, claims: [c], events,
      extras: { names: { [kagiso.toBase58()]: "Kagiso", [zodwa.toBase58()]: "Zodwa", [lerato.toBase58()]: "Lerato" }, reasons: { [reasonHash]: "Paid already" }, fallbackKinds: { [lerato.toBase58()]: "family" }, reports: {} },
    });
    expect(g).toMatchObject({ enabled: true, address: "G", objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 });
    expect(g.seats[2]).toMatchObject({ holder: v[2].toBase58(), holderName: "Bongani", vacant: false });
    expect(g.seats[2].backups.map((b) => b.name)[0]).toBe("Kagiso");
    expect(g.seats[2].succession).toMatchObject({ verdict: "Approved", confirmedBy: v[0].toBase58(), pendingSince: 900, readyAt: 960, nextHolder: { wallet: kagiso.toBase58(), name: "Kagiso" } });
    expect(g.seats[0].succession).toBeNull();
    expect(g.objections[0]).toMatchObject({ kind: "Claim", seatIndex: 2, monitorName: "Zodwa", reason: "Paid already", status: "Open", votesUphold: 1 });
    expect(g.claimPayableAt).toEqual({ [claim.toBase58()]: 460 });
    expect(g.feed[0]).toMatchObject({ seatIndex: 2, kind: "Claim", objectionDeadline: 460, txSignature: "sig" });
    expect(g.feed[0].summary).toContain("Lerato");
    // Decided alone: twice the window, both for paying and for the monitors' countdown.
    const lone = assembleGuardians(raw, { estate, claims: [{ ...c, decidedAlone: true }], events, extras: { names: {}, reasons: {}, fallbackKinds: {}, reports: {} } });
    expect([lone.claimPayableAt?.[claim.toBase58()], lone.feed[0].objectionDeadline]).toEqual([520, 520]);
    // A succession wait stored as 0 reads as 60 s (Guard::succession_wait), as the program waits.
    const zero = await roundTrip("Guard", {
      estate: estateKey, objection_window_secs: new BN(60), succession_wait_secs: new BN(0), fallback_wait_secs: new BN(120),
      open_objections: 1, fallback: [lerato, sipho, D, D], fallback_dead: 1, fallback_started_at: new BN(0), fallback_done: false, bump: 1,
    });
    const z = assembleGuardians({ ...raw, guard: { address: "G", raw: zero } }, { estate, claims: [c], events, extras: { names: {}, reasons: {}, fallbackKinds: {}, reports: {} } });
    expect([z.successionWaitSecs, z.seats[2].succession?.readyAt]).toEqual([60, 960]);
    expect(g.fallback.recipients).toEqual([
      { wallet: lerato.toBase58(), name: "Lerato", kind: "family", dead: true, report: null },
      expect.objectContaining({ wallet: sipho.toBase58(), dead: false }),
    ]);
    expect(g.fallback.canStart).toBe(false); // seats are filled
  });
});
