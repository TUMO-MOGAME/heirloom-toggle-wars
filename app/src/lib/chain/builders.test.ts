/**
 * Every builder against the IDL: each account by name in the IDL's order, with its signer and writable flags, the
 * remaining accounts, and every argument by name. The expected addresses are written out here, so an alias in
 * instructions.ts that fills the wrong slot fails. Optional accounts are tested present and absent.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import * as ix from "./instructions";
import { findInstruction, getCoder, getIdl } from "./idl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, agentVotePda, assetPda, ata, beneficiaryPda, claimPda,
  estatePda, fallbackReportPda, guardPda, hardshipPda, mediaPda, objectionPda, offerPda, payeePda, residualPda, rulePda,
  seatPda, stampPda, yearCapPda,
} from "./pda";

const P = new PublicKey(getIdl().address);
const k = () => Keypair.generate().publicKey;
const [usdt, owner, agent, heir, payee, buyer, nft, who, caller, payer, recipient, rentTo, newKey] = Array.from({ length: 13 }, k);
const v = [k(), k(), k()] as [PublicKey, PublicKey, PublicKey];
const ctx: ix.Ctx = { programId: P, usdtMint: usdt };
const E = estatePda(P, owner);
const NONE = PublicKey.default;
const rule = rulePda(P, E, 3);
const claim = claimPda(P, rule, 65_536);
const asset = assetPda(P, E, nft);
const offer = offerPda(P, asset, buyer);
const hardship = hardshipPda(P, asset, heir);
const guard = guardPda(P, E);
const seats = [0, 1, 2].map((i) => seatPda(P, E, i));
const [H, R, C] = ["ab".repeat(32), "cd".repeat(32), "ef".repeat(32)];
const ben = (w: PublicKey) => beneficiaryPda(P, E, w);
const report = (i: number) => fallbackReportPda(P, E, i);

type Accounts = Record<string, PublicKey | null>; // null = Anchor's None
interface Case { build(): TransactionInstruction; accounts?: Accounts; args?: unknown[]; remaining?: PublicKey[] }

/** Accounts that mean the same in every instruction. */
const SAME: Accounts = {
  estate: E, guard, seat0: seats[0], seat1: seats[1], seat2: seats[2], usdt_mint: usdt, vault: ata(usdt, E),
  fallback_report0: report(0), fallback_report1: report(1), fallback_report2: report(2), fallback_report3: report(3),
  system_program: SYSTEM_PROGRAM_ID, token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
};

const ruleInput = { ruleId: 3, beneficiaryWallet: heir, category: "Accommodation", allowedPayeeKind: "Landlord", maxPerClaim: 5n, lifetimeCap: 50n, validUntil: 2_000_000_000, startsNow: true } as const;
const ruleArgs = [3, "accommodation", "landlord", "5", "50", "2000000000", true];
const offerAccounts = { buyer, asset, offer, offer_escrow: ata(usdt, offer) };
const saleAccounts = {
  ...offerAccounts, agent, recipient, recipient_usdt: ata(usdt, recipient), nft_mint: nft, nft_escrow: ata(nft, E),
  buyer_nft: ata(nft, buyer), objection: objectionPda(P, asset),
};
const sale = { estate: E, agent, asset, nftMint: nft, buyer, recipient, expectedAmount: 9n };
const vote = (kind: Parameters<typeof ix.voteObjection>[1]["kind"], target: PublicKey, hardshipAsset?: PublicKey) =>
  ix.voteObjection(ctx, { voter: who, estate: E, kind, target, uphold: false, hardshipAsset });
const voteAccounts = (target: PublicKey, passed: PublicKey | null, forAsset: PublicKey | null = null): Accounts =>
  ({ voter: who, objection: objectionPda(P, target), target_account: passed, asset: forAsset });

const CASES: Record<string, Case[]> = {
  create_estate: [{
    build: () => ix.createEstate(ctx, { owner, agent, verifiers: v, deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 3, waitingPeriodSecs: 120 }),
    accounts: { owner }, args: [agent, v, 2, 1, 3, "120"],
  }],
  set_will: [{ build: () => ix.setWill(ctx, owner, H, "heirloom:will:x"), accounts: { owner }, args: [H, "heirloom:will:x"] }],
  add_beneficiary: [{ build: () => ix.addBeneficiary(ctx, owner, heir, "Family member 1"), accounts: { owner, wallet: heir, beneficiary: ben(heir) }, args: ["Family member 1"] }],
  add_payee: [{ build: () => ix.addPayee(ctx, owner, payee, "School", "A school"), accounts: { owner, wallet: payee, payee: payeePda(P, E, payee) }, args: ["school", "A school"] }],
  add_rule_v2: [
    {
      build: () => ix.addRule(ctx, owner, { ...ruleInput, recurring: { amount: 4n, intervalSecs: 60, firstDue: 1_900_000_000, payeeWallet: payee } }),
      accounts: { owner, beneficiary: ben(heir), rule, payee: payeePda(P, E, payee), year_cap: yearCapPda(P, rule) },
      args: [...ruleArgs, "4", "60", "1900000000"],
    },
    {
      build: () => ix.addRule(ctx, owner, ruleInput),
      accounts: { owner, beneficiary: ben(heir), rule, payee: null, year_cap: yearCapPda(P, rule) }, args: [...ruleArgs, "0", "0", "0"],
    },
  ],
  deposit: [{ build: () => ix.deposit(ctx, owner, 7n), accounts: { owner, owner_usdt: ata(usdt, owner) }, args: ["7"] }],
  withdraw: [{ build: () => ix.withdraw(ctx, owner, 8n), accounts: { owner, owner_usdt: ata(usdt, owner) }, args: ["8"] }],
  heartbeat: [{ build: () => ix.heartbeat(ctx, owner), accounts: { owner } }],
  register_asset: [{
    build: () => ix.registerAsset(ctx, owner, { nftMint: nft, floorPrice: 9n, hardshipFloor: 7n, askingPrice: 10n, proceedsTo: recipient, docHashHex: H }),
    accounts: { owner, nft_mint: nft, owner_nft: ata(nft, owner), nft_escrow: ata(nft, E), asset }, args: ["9", "7", "10", recipient, H],
  }],
  // Only the account the reporter holds: a passed optional account must exist.
  submit_death_claim: [
    { build: () => ix.submitDeathClaim(ctx, E, heir, H), accounts: { beneficiary: heir, beneficiary_account: ben(heir), guard: null, objection: objectionPda(P, E) }, args: [H] },
    { build: () => ix.submitDeathClaim(ctx, E, v[1], H, {}), accounts: { beneficiary: v[1], beneficiary_account: null, guard: null, objection: objectionPda(P, E) }, args: [H] },
    { build: () => ix.submitDeathClaim(ctx, E, recipient, H, { listed: true }), accounts: { beneficiary: recipient, beneficiary_account: null, guard, objection: objectionPda(P, E) }, args: [H] },
  ],
  review_death: [{ build: () => ix.reviewDeath(E, agent, "Refer", R, C), accounts: { agent }, args: ["refer", R, C] }],
  attest_death: [{ build: () => ix.attestDeath(E, v[0]), accounts: { verifier: v[0] } }],
  veto_death: [{ build: () => ix.vetoDeath(ctx, owner), accounts: { owner } }],
  finalize_unlock: [{ build: () => ix.finalizeUnlock(E, caller), accounts: { objection: objectionPda(P, E), caller } }],
  submit_claim: [{
    build: () => ix.submitClaim(ctx, { estate: E, signer: heir, ruleId: 3, claimId: 65_536, payeeWallet: payee, amount: 2n, evidenceHashHex: H }),
    accounts: { beneficiary: heir, beneficiary_account: ben(heir), rule, payee: payeePda(P, E, payee), claim, year_cap: yearCapPda(P, rule) }, args: ["2", H],
  }],
  review_claim: [{ build: () => ix.reviewClaim(E, agent, claim, rule, "Reject", R), accounts: { agent, claim }, args: ["reject", R] }],
  approve_claim: [{ build: () => ix.approveClaim(E, v[1], claim, rule), accounts: { verifier: v[1], claim, payer: v[1], approval_stamp: stampPda(P, claim) } }],
  execute_claim: [{
    build: () => ix.executeClaim(ctx, { estate: E, payer, rule, claim, beneficiary: heir, payeeWallet: payee }),
    accounts: {
      payer, rule, claim, payee_wallet: payee, payee_usdt: ata(usdt, payee), approval_stamp: stampPda(P, claim), objection: objectionPda(P, claim),
      year_cap: yearCapPda(P, rule), beneficiary_account: ben(heir), payee_account: payeePda(P, E, payee),
    },
  }],
  owner_approve_claim: [{ build: () => ix.ownerApproveClaim(ctx, owner, claim, rule), accounts: { owner, rule, claim } }],
  execute_scheduled: [{
    build: () => ix.executeScheduled(ctx, { estate: E, payer, rule, beneficiary: heir, payeeWallet: payee }),
    accounts: {
      payer, rule, payee_wallet: payee, payee_usdt: ata(usdt, payee), year_cap: yearCapPda(P, rule),
      beneficiary_account: ben(heir), payee_account: payeePda(P, E, payee),
    },
  }],
  list_asset: [{ build: () => ix.listAsset(E, agent, asset, 3_600), accounts: { authority: agent, asset }, args: ["3600"] }],
  place_offer: [{ build: () => ix.placeOffer(ctx, E, asset, buyer, 9n), accounts: { ...offerAccounts, buyer_usdt: ata(usdt, buyer) }, args: ["9"] }],
  withdraw_offer: [{ build: () => ix.withdrawOffer(ctx, E, asset, buyer), accounts: { ...offerAccounts, buyer_usdt: ata(usdt, buyer) } }],
  submit_hardship: [{ build: () => ix.submitHardship(ctx, E, asset, heir, H), accounts: { beneficiary: heir, beneficiary_account: ben(heir), asset, hardship }, args: [H] }],
  review_hardship: [{ build: () => ix.reviewHardship(E, agent, asset, hardship, "Approve", R), accounts: { agent, asset, hardship }, args: ["approve", R] }],
  approve_hardship: [{ build: () => ix.approveHardship(E, v[2], asset, hardship), accounts: { verifier: v[2], asset, hardship, payer: v[2], approval_stamp: stampPda(P, hardship) } }],
  accept_offer: [
    {
      build: () => ix.acceptOffer(ctx, { ...sale, coSigner: v[0] }),
      accounts: { ...saleAccounts, hardship_objection: SYSTEM_PROGRAM_ID, hardship_stamp: SYSTEM_PROGRAM_ID, co_signer: v[0] }, args: ["9"],
    },
    {
      build: () => ix.acceptOffer(ctx, { ...sale, coSigner: null, hardshipBeneficiary: heir }),
      accounts: { ...saleAccounts, hardship_objection: objectionPda(P, hardship), hardship_stamp: stampPda(P, hardship), co_signer: null }, args: ["9"],
    },
  ],
  init_guard: [{ build: () => ix.initGuard(ctx, owner, E, { objectionWindowSecs: 1, successionWaitSecs: 2, fallbackWaitSecs: 3 }), accounts: { authority: owner }, args: ["1", "2", "3"] }],
  init_seat: [{ build: () => ix.initSeat(ctx, owner, 2, [heir], [who, newKey]), accounts: { owner, seat: seats[2] }, args: [2, [heir, NONE], [who, newKey]] }],
  set_seat_backups: [{ build: () => ix.setSeatBackups(ctx, v[2], E, 2, [heir, who]), accounts: { authority: v[2], seat: seats[2] }, args: [2, [heir, who]] }],
  set_seat_monitors: [{ build: () => ix.setSeatMonitors(ctx, owner, 1, [who]), accounts: { owner, seat: seats[1] }, args: [1, [who, NONE]] }],
  set_fallback: [{ build: () => ix.setFallback(ctx, owner, [heir, recipient]), accounts: { owner }, args: [[heir, recipient, NONE, NONE]] }],
  owner_replace_seat: [
    { build: () => ix.ownerReplaceSeat(ctx, owner, 1, newKey), accounts: { owner, seat: seats[1], next_seat: seats[2], last_seat: seats[0] }, args: [1, newKey] },
    { build: () => ix.ownerReplaceSeat(ctx, owner, 2, newKey), accounts: { owner, seat: seats[2], next_seat: seats[0], last_seat: seats[1] }, args: [2, newKey] },
  ],
  report_seat_death: [
    {
      build: () => ix.reportSeatDeath(ctx, who, E, 2, C, { beneficiary: true }),
      accounts: { reporter: who, seat: seats[2], beneficiary_account: ben(who), objection: objectionPda(P, seats[2]) }, args: [2, C],
    },
    { build: () => ix.reportSeatDeath(ctx, who, E, 2, C), accounts: { reporter: who, seat: seats[2], beneficiary_account: null, objection: objectionPda(P, seats[2]) }, args: [2, C] },
  ],
  review_seat_death: [{ build: () => ix.reviewSeatDeath(E, agent, 2, true, R, C, v[2]), accounts: { agent, seat: seats[2] }, args: [2, true, R, C, v[2]] }],
  confirm_seat_death: [
    { build: () => ix.confirmSeatDeath(ctx, who, E, 2, { beneficiary: true }), accounts: { confirmer: who, seat: seats[2], beneficiary_account: ben(who) }, args: [2] },
    { build: () => ix.confirmSeatDeath(ctx, v[0], E, 2), accounts: { confirmer: v[0], seat: seats[2], beneficiary_account: null }, args: [2] },
  ],
  veto_seat_death: [{ build: () => ix.vetoSeatDeath(ctx, v[2], E, 2), accounts: { holder: v[2], seat: seats[2] }, args: [2] }],
  // No remaining account: the program reads none.
  finalize_succession: [{ build: () => ix.finalizeSuccession(ctx, E, 2, caller), accounts: { seat: seats[2], objection: objectionPda(P, seats[2]), caller }, args: [2] }],
  raise_objection: [
    {
      build: () => ix.raiseObjection(ctx, { objector: who, estate: E, kind: "Hardship", target: hardship, seatIndex: 1, reasonHashHex: H, monitorSeat: 1, hardshipAsset: asset }),
      accounts: { objector: who, seat: seats[1], beneficiary_account: null, target_account: hardship, asset, objection: objectionPda(P, hardship) },
      args: ["hardship", hardship, 1, H],
    },
    {
      build: () => ix.raiseObjection(ctx, { objector: heir, estate: E, kind: "Fallback", target: guard, seatIndex: null, reasonHashHex: H, monitorSeat: null, beneficiary: true }),
      accounts: { objector: heir, seat: null, beneficiary_account: ben(heir), target_account: null, asset: null, objection: objectionPda(P, guard) },
      args: ["fallback", guard, 255, H],
    },
  ],
  // A dismissal needs the target too: the program checks who gains from it.
  vote_objection: [
    { build: () => vote("Claim", claim), accounts: voteAccounts(claim, claim), args: [false] },
    { build: () => vote("Sale", asset), accounts: voteAccounts(asset, asset), args: [false] },
    { build: () => vote("Hardship", hardship, asset), accounts: voteAccounts(hardship, hardship, asset), args: [false] },
    { build: () => vote("Succession", seats[1]), accounts: voteAccounts(seats[1], seats[1]), args: [false] },
    { build: () => vote("Unlock", E), accounts: voteAccounts(E, null), args: [false] },
    { build: () => vote("Fallback", guard), accounts: voteAccounts(guard, null), args: [false], remaining: seats },
  ],
  set_asset_media: [{
    build: () => ix.setAssetMedia(ctx, { authority: owner, estate: E, asset, kind: "Motorbike", photosRootHex: H, photoCount: 4 }),
    accounts: { authority: owner, asset, media: mediaPda(P, asset) }, args: ["motorbike", H, 4],
  }],
  report_fallback_death: [
    {
      build: () => ix.reportFallbackDeath(ctx, who, E, 1, C, { monitorSeat: 0, beneficiary: true }),
      accounts: { reporter: who, fallback_report: report(1), signer_seat: seats[0], beneficiary_account: ben(who) }, args: [1, C],
    },
    { build: () => ix.reportFallbackDeath(ctx, v[0], E, 1, C), accounts: { reporter: v[0], fallback_report: report(1), signer_seat: null, beneficiary_account: null }, args: [1, C] },
  ],
  review_fallback_death: [{
    build: () => ix.reviewFallbackDeath(E, agent, 1, false, R, C, rentTo, recipient),
    accounts: { agent, fallback_report: report(1), rent_to: rentTo }, args: [1, false, R, C, recipient],
  }],
  resolve_fallback_death: [
    {
      build: () => ix.resolveFallbackDeath(ctx, { signer: who, estate: E, index: 2, dead: true, rentTo, as: { monitorSeat: 2, beneficiary: true } }),
      accounts: { signer: who, fallback_report: report(2), rent_to: rentTo, signer_seat: seats[2], beneficiary_account: ben(who) }, args: [2, true],
    },
    {
      build: () => ix.resolveFallbackDeath(ctx, { signer: recipient, estate: E, index: 2, dead: false, rentTo }),
      accounts: { signer: recipient, fallback_report: report(2), rent_to: rentTo, signer_seat: null, beneficiary_account: null }, args: [2, false],
    },
  ],
  start_fallback: [{ build: () => ix.startFallback(ctx, E, caller), accounts: { caller } }],
  lapse_objection: [{ build: () => ix.lapseObjection(ctx, E, caller), accounts: { objection: objectionPda(P, guard), caller } }],
  execute_fallback: [{
    build: () => ix.executeFallback(ctx, { payer, estate: E, recipient, recipientIndex: 2 }),
    accounts: {
      payer, objection: objectionPda(P, guard), recipient, recipient_usdt: ata(usdt, recipient), fallback_report: report(2), unlock_objection: objectionPda(P, E),
    },
  }],
  raise_dispute: [
    {
      build: () => ix.raiseDispute(ctx, { disputer: heir, estate: E, kind: "Claim", target: claim, reasonHashHex: H, beneficiary: true }),
      accounts: { disputer: heir, beneficiary_account: ben(heir), target_account: claim, objection: objectionPda(P, claim) }, args: ["claim", claim, H],
    },
    {
      build: () => ix.raiseDispute(ctx, { disputer: v[0], estate: E, kind: "Unlock", target: E, reasonHashHex: H, beneficiary: false }),
      accounts: { disputer: v[0], beneficiary_account: null, target_account: null, objection: objectionPda(P, E) }, args: ["unlock", E, H],
    },
  ],
  resolve_dispute: [
    { build: () => ix.resolveDispute(ctx, { verifier: v[1], estate: E, kind: "Claim", target: claim, uphold: false }), accounts: { verifier: v[1], objection: objectionPda(P, claim), target_account: claim }, args: [false] },
    { build: () => ix.resolveDispute(ctx, { verifier: v[1], estate: E, kind: "Unlock", target: E, uphold: true }), accounts: { verifier: v[1], objection: objectionPda(P, E), target_account: null }, args: [true] },
  ],
  set_yearly_cap: [{ build: () => ix.setYearlyCap(ctx, { owner, rule, cap: 30n, periodStart: 0 }), accounts: { owner, rule, year_cap: yearCapPda(P, rule) }, args: ["30", "0"] }],
  end_rule: [{ build: () => ix.endRule(ctx, owner, rule), accounts: { owner, rule } }],
  set_residual: [{ build: () => ix.setResidual(ctx, owner, recipient), accounts: { owner, residual: residualPda(P, E) }, args: [recipient] }],
  sweep_residual: [1, 255].map((index) => ({
    build: () => ix.sweepResidual(ctx, { payer, estate: E, recipient, reportIndex: index, rules: [rulePda(P, E, 0), rulePda(P, E, 1)] }),
    accounts: { payer, residual: residualPda(P, E), recipient, recipient_usdt: ata(usdt, recipient), fallback_report: report(index) },
    remaining: [rulePda(P, E, 0), rulePda(P, E, 1)],
  })),
  set_agent: [{ build: () => ix.setAgent(ctx, owner, newKey), accounts: { owner }, args: [newKey] }],
  // Remaining: [0] the voter's Beneficiary PDA always, [1] after the unlock their own open claim.
  vote_agent: [
    { build: () => ix.voteAgent(ctx, E, v[0], newKey), accounts: { verifier: v[0], agent_vote: agentVotePda(P, E, newKey) }, args: [newKey], remaining: [ben(v[0])] },
    { build: () => ix.voteAgent(ctx, E, v[0], newKey, claim), accounts: { verifier: v[0], agent_vote: agentVotePda(P, E, newKey) }, args: [newKey], remaining: [ben(v[0]), claim] },
  ],
  release_asset: [{
    build: () => ix.releaseAsset(ctx, owner, asset, nft),
    accounts: { owner, asset, nft_mint: nft, nft_escrow: ata(nft, E), owner_nft: ata(nft, owner) },
  }],
  remove_member: [
    { build: () => ix.removeMember(ctx, owner, { beneficiary: heir }), accounts: { owner, beneficiary_account: ben(heir), payee_account: null } },
    { build: () => ix.removeMember(ctx, owner, { payee }), accounts: { owner, beneficiary_account: null, payee_account: payeePda(P, E, payee) } },
    { build: () => ix.removeMember(ctx, owner, { beneficiary: heir, payee }), accounts: { owner, beneficiary_account: ben(heir), payee_account: payeePda(P, E, payee) } },
  ],
};

/** Keys as base58, integers of any width as strings, hashes as hex, enums as their lower-case variant. */
function plain(x: unknown): unknown {
  if (x instanceof PublicKey) return x.toBase58();
  if (x instanceof Uint8Array) return Buffer.from(x).toString("hex");
  if (Array.isArray(x)) return x.length === 32 && x.every((n) => typeof n === "number") ? Buffer.from(x).toString("hex") : x.map(plain);
  if (!x || typeof x !== "object") return x;
  if ("toBase58" in x) return (x as PublicKey).toBase58();
  if ("toArrayLike" in x) return String(x); // BN
  return Object.keys(x)[0].toLowerCase(); // an enum
}

describe("every builder is the IDL's instruction", () => {
  it("every instruction of the IDL has a case, and nothing else", () => {
    expect(Object.keys(CASES).sort()).toEqual(getIdl().instructions.map((i) => i.name).sort());
  });

  for (const [name, variants] of Object.entries(CASES)) {
    variants.forEach((c, n) => {
      it(`${name}${variants.length > 1 ? ` (${n + 1})` : ""}: accounts, order, flags and arguments`, () => {
        const def = findInstruction(name);
        const t = c.build();
        expect(t.programId.equals(P)).toBe(true);
        expect([...t.data.subarray(0, 8)]).toEqual([...def.discriminator]);

        const given = { ...SAME, ...c.accounts };
        const idlAccounts = def.accounts as { name: string; signer?: boolean; writable?: boolean; optional?: boolean }[];
        const named = idlAccounts.map((a) => {
          if (!(a.name in given)) throw new Error(`${name}: the test names no expected address for ${a.name}`);
          const at = given[a.name];
          if (!at && !a.optional) throw new Error(`${name}: ${a.name} is not optional`);
          return at ? [a.name, at.toBase58(), !!a.signer, !!a.writable] : [a.name, P.toBase58(), false, false];
        });
        const remaining = (c.remaining ?? []).map((r) => ["remaining", r.toBase58(), false, false]);
        expect(t.keys.map((m, i) => [idlAccounts[i]?.name ?? "remaining", m.pubkey.toBase58(), m.isSigner, m.isWritable]))
          .toEqual([...named, ...remaining]);

        const data = getCoder().instruction.decode(Buffer.from(t.data))!.data as Record<string, unknown>;
        expect(def.args.map((a) => [a.name, plain(data[a.name])])).toEqual(def.args.map((a, i) => [a.name, plain((c.args ?? [])[i])]));
        expect(c.args ?? []).toHaveLength(def.args.length);
      });
    });
  }

  it("a rule id outside the u16 range and a malformed hash never become an instruction", () => {
    expect(() => ix.addRule(ctx, owner, { ...ruleInput, ruleId: 65_536 })).toThrow(RangeError);
    expect(() => ix.reviewDeath(E, agent, "Approve", R, "not a hash")).toThrow(/hex/);
    expect(() => ix.removeMember(ctx, owner, {})).toThrow(/^BadStatus/);
  });
});
