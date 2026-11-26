/**
 * Builds every instruction against the real IDL (src/lib/chain/idl/heirloom.json): catches drift between
 * the contract's account/arg names and our builders before it reaches devnet.
 */
import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as ix from "./instructions";
import { findInstruction, getCoder, getIdl } from "./idl";
import { assetPda, claimPda, estatePda, guardPda, hardshipPda, objectionPda, offerPda, rulePda, seatPda, stampPda, yearCapPda } from "./pda";
import { decodeEstate, type Raw } from "./decoders";

const k = () => Keypair.generate().publicKey;
const programId = new PublicKey(getIdl().address);
const ctx: ix.Ctx = { programId, usdtMint: k() };
const owner = k(), agent = k(), ben = k(), payee = k(), buyer = k(), nft = k();
const v = [k(), k(), k()] as [PublicKey, PublicKey, PublicKey];
const estate = estatePda(programId, owner);
const asset = assetPda(programId, estate, nft);
const rule0 = rulePda(programId, estate, 0);
const H = "ab".repeat(32);

const built: Record<string, () => ReturnType<typeof ix.buildIx>> = {
  create_estate: () => ix.createEstate(ctx, { owner, agent, verifiers: v, deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 300 }),
  set_will: () => ix.setWill(ctx, owner, H, "heirloom:will:x"),
  add_beneficiary: () => ix.addBeneficiary(ctx, owner, ben, "Lerato"),
  add_payee: () => ix.addPayee(ctx, owner, payee, "University", "UCT"),
  add_rule_v2: () => ix.addRule(ctx, owner, { ruleId: 0, beneficiaryWallet: ben, category: "Tuition", allowedPayeeKind: "University", maxPerClaim: 1n, lifetimeCap: 2n, validUntil: 2e9 }),
  deposit: () => ix.deposit(ctx, owner, 5n),
  withdraw: () => ix.withdraw(ctx, owner, 5n),
  heartbeat: () => ix.heartbeat(ctx, owner),
  register_asset: () => ix.registerAsset(ctx, owner, { nftMint: nft, floorPrice: 9n, hardshipFloor: 7n, askingPrice: 10n, proceedsTo: owner, docHashHex: H }),
  submit_death_claim: () => ix.submitDeathClaim(ctx, estate, ben, H),
  review_death: () => ix.reviewDeath(estate, agent, "Approve", H, H),
  attest_death: () => ix.attestDeath(estate, v[0]),
  veto_death: () => ix.vetoDeath(ctx, owner),
  finalize_unlock: () => ix.finalizeUnlock(estate, ben),
  submit_claim: () => ix.submitClaim(ctx, { estate, signer: ben, ruleId: 0, claimId: 0, payeeWallet: payee, amount: 1n, evidenceHashHex: H }),
  review_claim: () => ix.reviewClaim(estate, agent, claimPda(programId, rule0, 0), rule0, "Reject", H),
  approve_claim: () => ix.approveClaim(estate, v[1], k(), k()),
  execute_claim: () => ix.executeClaim(ctx, { estate, payer: ben, rule: k(), claim: k(), beneficiary: ben, payeeWallet: payee }),
  list_asset: () => ix.listAsset(estate, agent, asset, 3600),
  place_offer: () => ix.placeOffer(ctx, estate, asset, buyer, 9n),
  withdraw_offer: () => ix.withdrawOffer(ctx, estate, asset, buyer),
  submit_hardship: () => ix.submitHardship(ctx, estate, asset, ben, H),
  review_hardship: () => ix.reviewHardship(estate, agent, asset, hardshipPda(programId, asset, ben), "Refer", H),
  approve_hardship: () => ix.approveHardship(estate, v[2], asset, k()),
  accept_offer: () => ix.acceptOffer(ctx, { estate, agent, asset, nftMint: nft, buyer, recipient: owner, expectedAmount: 9n, coSigner: v[0] }),
  owner_approve_claim: () => ix.ownerApproveClaim(ctx, owner, k(), rule0),
  execute_scheduled: () => ix.executeScheduled(ctx, { estate, payer: agent, rule: rule0, beneficiary: ben, payeeWallet: payee }),
  // guardians
  init_guard: () => ix.initGuard(ctx, owner, estate, { objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 }),
  init_seat: () => ix.initSeat(ctx, owner, 2, [k(), k()], [k()]),
  set_seat_backups: () => ix.setSeatBackups(ctx, v[2], estate, 2, [k()]),
  set_seat_monitors: () => ix.setSeatMonitors(ctx, owner, 2, [k()]),
  set_fallback: () => ix.setFallback(ctx, owner, [ben, k(), k(), k()]),
  owner_replace_seat: () => ix.ownerReplaceSeat(ctx, owner, 1, k()),
  report_seat_death: () => ix.reportSeatDeath(ctx, ben, estate, 2, H),
  review_seat_death: () => ix.reviewSeatDeath(estate, agent, 2, true, H, H, v[2]),
  confirm_seat_death: () => ix.confirmSeatDeath(ctx, v[0], estate, 2),
  veto_seat_death: () => ix.vetoSeatDeath(ctx, v[2], estate, 2),
  finalize_succession: () => ix.finalizeSuccession(ctx, estate, 2, ben),
  raise_objection: () => ix.raiseObjection(ctx, { objector: ben, estate, kind: "Claim", target: k(), seatIndex: 2, reasonHashHex: H, monitorSeat: 2 }),
  vote_objection: () => ix.voteObjection(ctx, { voter: v[0], estate, kind: "Claim", target: k(), uphold: true }),
  set_asset_media: () => ix.setAssetMedia(ctx, { authority: owner, estate, asset, kind: "Car", photosRootHex: H, photoCount: 3 }),
  report_fallback_death: () => ix.reportFallbackDeath(ctx, ben, estate, 0, H),
  review_fallback_death: () => ix.reviewFallbackDeath(estate, agent, 0, true, H, H, ben, k()),
  resolve_fallback_death: () => ix.resolveFallbackDeath(ctx, { signer: ben, estate, index: 0, dead: false, rentTo: ben }),
  release_asset: () => ix.releaseAsset(ctx, owner, asset, nft),
  remove_member: () => ix.removeMember(ctx, owner, { beneficiary: ben }),
  start_fallback: () => ix.startFallback(ctx, estate, ben),
  lapse_objection: () => ix.lapseObjection(ctx, estate, ben),
  execute_fallback: () => ix.executeFallback(ctx, { payer: ben, estate, recipient: ben, recipientIndex: 0 }),
  // disputes and yearly caps
  raise_dispute: () => ix.raiseDispute(ctx, { disputer: ben, estate, kind: "Claim", target: k(), reasonHashHex: H, beneficiary: true }),
  resolve_dispute: () => ix.resolveDispute(ctx, { verifier: v[0], estate, kind: "Unlock", target: estate, uphold: true }),
  set_yearly_cap: () => ix.setYearlyCap(ctx, { owner, rule: rule0, cap: 3_000_000_000n, periodStart: 0 }),
  // continuity
  end_rule: () => ix.endRule(ctx, owner, rule0),
  end_orphan_rule: () => ix.endOrphanRule(ctx, { caller: k(), estate, rule: rule0, beneficiaryWallet: ben }),
  set_residual: () => ix.setResidual(ctx, owner, ben),
  sweep_residual: () => ix.sweepResidual(ctx, { payer: ben, estate, recipient: ben, reportIndex: 255, rules: [] }),
  set_agent: () => ix.setAgent(ctx, owner, k()),
  vote_agent: () => ix.voteAgent(ctx, estate, v[0], k()),
};
const idlNames = new Set(getIdl().instructions.map((i) => i.name));

describe("instruction builders vs IDL", () => {
  it("covers every IDL instruction", () => {
    for (const n of idlNames) expect(Object.keys(built)).toContain(n);
  });

  for (const [name, build] of Object.entries(built).filter(([n]) => idlNames.has(n))) {
    it(`${name}: resolves all accounts and round-trips data`, () => {
      const t = build();
      expect(t.programId.equals(programId)).toBe(true);
      // buildIx throws if any account is missing; check the count matches the IDL too.
      // vote_agent always carries one remaining account: the voter's Beneficiary PDA.
      expect(t.keys.length).toBe(findInstruction(name).accounts.length + (name === "vote_agent" ? 1 : 0));
      const decoded = getCoder().instruction.decode(Buffer.from(t.data));
      expect(decoded?.name).toBe(findInstruction(name).name);
    });
  }

  it("beneficiary instructions: the wallet signs, the PDA is beneficiary_account", () => {
    const t = built.submit_claim();
    expect(t.keys.filter((m) => m.isSigner).map((m) => m.pubkey.toBase58())).toEqual([ben.toBase58()]);
  });

  it("offer accounts use the offer PDA", () => {
    expect(built.place_offer().keys.some((m) => m.pubkey.equals(offerPda(programId, asset, buyer)))).toBe(true);
  });

  it("living-plan add_rule: recurring + starts_now", () => {
    const make = () => ix.addRule(ctx, owner, {
      ruleId: 1, beneficiaryWallet: ben, category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaim: 5n, lifetimeCap: 50n,
      validUntil: 2e9, startsNow: true, recurring: { amount: 5n, intervalSecs: 60, firstDue: 1e9, payeeWallet: payee },
    });
    const decoded = getCoder().instruction.decode(Buffer.from(make().data)) as { data: Record<string, unknown> } | null;
    expect(Object.values(decoded!.data)).toContain(true);
  });

  it("guardians: PDAs land in the right account slots", () => {
    const names = (n: string) => findInstruction(n).accounts.map((a) => a.name);
    const at = (n: string, t: ReturnType<typeof ix.buildIx>, acc: string) => t.keys[names(n).indexOf(acc)].pubkey;
    const claim = k();
    const ap = ix.approveClaim(estate, v[1], claim, k());
    expect(at("approve_claim", ap, "approval_stamp").equals(stampPda(programId, claim))).toBe(true);
    expect(at("approve_claim", ap, "payer").equals(v[1])).toBe(true);
    const ex = ix.executeClaim(ctx, { estate, payer: ben, rule: k(), claim, beneficiary: ben, payeeWallet: payee });
    expect(at("execute_claim", ex, "guard").equals(guardPda(programId, estate))).toBe(true);
    expect(at("execute_claim", ex, "objection").equals(objectionPda(programId, claim))).toBe(true);
    expect(at("finalize_unlock", ix.finalizeUnlock(estate, ben), "objection").equals(objectionPda(programId, estate))).toBe(true);
    const seat = seatPda(programId, estate, 2);
    expect(at("finalize_succession", ix.finalizeSuccession(ctx, estate, 2, ben), "objection").equals(objectionPda(programId, seat))).toBe(true);
    const guard = guardPda(programId, estate);
    expect(at("lapse_objection", ix.lapseObjection(ctx, estate, ben), "objection").equals(objectionPda(programId, guard))).toBe(true);
    const exf = ix.executeFallback(ctx, { payer: ben, estate, recipient: ben, recipientIndex: 0 });
    expect(exf.keys[names("execute_fallback").indexOf("objection")]).toMatchObject({ isWritable: true });
    // accept_offer: the hardship objection only when a hardship sale is approved, else the system program
    const plain = ix.acceptOffer(ctx, { estate, agent, asset, nftMint: nft, buyer, recipient: owner, expectedAmount: 9n, coSigner: v[0] });
    expect(at("accept_offer", plain, "hardship_objection").toBase58()).toBe("11111111111111111111111111111111");
    const hs = ix.acceptOffer(ctx, { estate, agent, asset, nftMint: nft, buyer, recipient: ben, expectedAmount: 7n, coSigner: v[0], hardshipBeneficiary: ben });
    expect(at("accept_offer", hs, "hardship_objection").equals(objectionPda(programId, hardshipPda(programId, asset, ben)))).toBe(true);
    // and its quorum stamp likewise (a hardship approval waits out the objection window with a Guard)
    expect(at("accept_offer", plain, "hardship_stamp").toBase58()).toBe("11111111111111111111111111111111");
    expect(at("accept_offer", hs, "hardship_stamp").equals(stampPda(programId, hardshipPda(programId, asset, ben)))).toBe(true);
    expect(at("accept_offer", hs, "guard").equals(guardPda(programId, estate))).toBe(true);
    // raise_objection: optional accounts not passed become the program id (Anchor's None)
    const un = ix.raiseObjection(ctx, { objector: ben, estate, kind: "Unlock", target: estate, seatIndex: null, reasonHashHex: H, monitorSeat: 1 });
    expect(at("raise_objection", un, "target_account").equals(programId)).toBe(true);
    expect(at("raise_objection", un, "seat").equals(seatPda(programId, estate, 1))).toBe(true);
    const decoded = getCoder().instruction.decode(Buffer.from(un.data)) as unknown as { data: { seat_index: number } };
    expect(decoded.data.seat_index).toBe(255);
  });

  it("disputes, yearly caps and sponsorable callers: PDAs and signers land in the right slots", () => {
    const names = (n: string) => findInstruction(n).accounts.map((a) => a.name);
    const slot = (n: string, t: ReturnType<typeof ix.buildIx>, acc: string) => t.keys[names(n).indexOf(acc)];
    const claim = k();
    const rd = ix.raiseDispute(ctx, { disputer: ben, estate, kind: "Claim", target: claim, reasonHashHex: H, beneficiary: true });
    expect(slot("raise_dispute", rd, "objection").pubkey.equals(objectionPda(programId, claim))).toBe(true);
    expect(slot("raise_dispute", rd, "target_account").pubkey.equals(claim)).toBe(true);
    expect(slot("raise_dispute", rd, "disputer")).toMatchObject({ isSigner: true });
    const decoded = getCoder().instruction.decode(Buffer.from(rd.data)) as unknown as { data: { kind: Record<string, unknown> } };
    expect(Object.keys(decoded.data.kind)[0].toLowerCase()).toBe("claim");
    // A verifier passes no Beneficiary PDA; an Unlock dispute no target account (both Anchor None = the program id).
    const vu = ix.raiseDispute(ctx, { disputer: v[1], estate, kind: "Unlock", target: estate, reasonHashHex: H, beneficiary: false });
    expect(slot("raise_dispute", vu, "beneficiary_account").pubkey.equals(programId)).toBe(true);
    expect(slot("raise_dispute", vu, "target_account").pubkey.equals(programId)).toBe(true);
    const rs = ix.resolveDispute(ctx, { verifier: v[0], estate, kind: "Claim", target: claim, uphold: false });
    expect(slot("resolve_dispute", rs, "target_account")).toMatchObject({ isWritable: true });
    expect(slot("resolve_dispute", rs, "target_account").pubkey.equals(claim)).toBe(true);
    // year_cap: the rule's ["yearcap", rule] PDA, writable where payments record their spend.
    const rule = k();
    const yc = yearCapPda(programId, rule);
    expect(slot("set_yearly_cap", ix.setYearlyCap(ctx, { owner, rule, cap: 1n, periodStart: 0 }), "year_cap").pubkey.equals(yc)).toBe(true);
    expect(slot("execute_claim", ix.executeClaim(ctx, { estate, payer: ben, rule, claim, beneficiary: ben, payeeWallet: payee }), "year_cap")).toMatchObject({ pubkey: yc, isWritable: true });
    expect(slot("execute_scheduled", ix.executeScheduled(ctx, { estate, payer: ben, rule, beneficiary: ben, payeeWallet: payee }), "year_cap")).toMatchObject({ pubkey: yc, isWritable: true });
    const sc = ix.submitClaim(ctx, { estate, signer: ben, ruleId: 0, claimId: 0, payeeWallet: payee, amount: 1n, evidenceHashHex: H });
    expect(slot("submit_claim", sc, "year_cap").pubkey.equals(yearCapPda(programId, rule0))).toBe(true);
    // The permissionless calls take any wallet as a signing caller, so the sponsor can pay their fee.
    for (const [n, t] of [["finalize_unlock", ix.finalizeUnlock(estate, ben)], ["finalize_succession", ix.finalizeSuccession(ctx, estate, 2, ben)],
      ["start_fallback", ix.startFallback(ctx, estate, ben)], ["lapse_objection", ix.lapseObjection(ctx, estate, ben)]] as const) {
      expect(slot(n, t, "caller")).toMatchObject({ pubkey: ben, isSigner: true, isWritable: false });
    }
  });

  it("rejects malformed hashes", () => {
    expect(() => ix.setWill(ctx, owner, "xyz", "u")).toThrow(/hex/);
  });
});

describe("decoders", () => {
  it("decodes an Estate account into the UI shape", async () => {
    const raw = {
      owner, agent, usdt_mint: ctx.usdtMint, verifiers: v, death_threshold: 2, claim_threshold: 1, hardship_threshold: 2,
      waiting_period_secs: new BN(120), status: { DeathPending: {} }, will_hash: Array(32).fill(1), will_uri: "x",
      death_cert_hash: Array(32).fill(0), death_submitted_by: PublicKey.default, death_verdict: { Approved: {} },
      death_attestations: 0b101, death_pending_since: new BN(1_700_000_000), last_heartbeat: new BN(1_690_000_000),
      rule_count: 3, bump: 255,
    };
    const data = await getCoder().accounts.encode("Estate", raw);
    const back = getCoder().accounts.decode("Estate", data) as Raw;
    const e = decodeEstate("E", back, 42n);
    expect(e.status).toBe("DeathPending");
    expect(e.death.verdict).toBe("Approved");
    expect(e.death.attestations).toEqual([true, false, true]);
    expect(e.death.certHash).toBeNull();
    expect(e.death.submittedBy).toBeNull();
    expect(e.death.pendingSince).toBe(1_700_000_000);
    expect(e.willHash).toBe("01".repeat(32));
    expect(e.waitingPeriodSecs).toBe(120);
    expect(e.vaultBalance).toBe(42n);
  });
});

describe("decoders (living plans, generated IDL)", () => {
  it("decodes Rule living-plan fields", async () => {
    const { decodeRule } = await import("./decoders");
    const raw = {
      estate, id: 1, beneficiary: ben, category: { Accommodation: {} }, allowed_payee_kind: { Landlord: {} },
      max_per_claim: new BN(300), lifetime_cap: new BN(9000), spent_total: new BN(0), valid_until: new BN(2_000_000_000),
      claim_count: 0, starts_now: true, recurring_amount: new BN(300), interval_secs: new BN(60), next_due: new BN(1_800_000_000),
      fixed_payee: payee, bump: 254,
    };
    const back = getCoder().accounts.decode("Rule", await getCoder().accounts.encode("Rule", raw)) as Raw;
    const r = (await import("./decoders")).decodeRule("R", back);
    expect(r).toMatchObject({ startsNow: true, recurringAmount: 300n, intervalSecs: 60, nextDue: 1_800_000_000, fixedPayee: payee.toBase58() });
    void decodeRule;
  });
});
