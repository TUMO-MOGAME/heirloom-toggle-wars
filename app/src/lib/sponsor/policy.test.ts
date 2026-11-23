import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram, Keypair, MessageV0, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createTransferCheckedInstruction, createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { findInstruction, getIdl } from "../chain/idl";
import { APPROVAL_STAMP_RENT, DEFAULT_LIMITS, SPONSOR_RENT_PAYER_ACCOUNTS, SPONSORED_HEIRLOOM_IXS, SponsorRejection, TOKEN_ACCOUNT_RENT, validateSponsoredTx, type RejectCode, type SponsorPolicy } from "./policy";
import { SponsorLimiter } from "./limits";
import { AGENT_ALLOWED } from "../agent/agent-wallet";
import * as ix from "../chain/instructions";
import { txBytes } from "../chain/pack";
import { estatePda } from "../chain/pda";

const sponsor = Keypair.generate();
const user = Keypair.generate();
const other = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const fakeMint = Keypair.generate().publicKey;
const programId = new PublicKey(getIdl().address);
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

const names = getIdl().instructions.map((i) => i.name);
const policy = (over: Partial<SponsorPolicy> = {}): SponsorPolicy => ({
  sponsor: sponsor.publicKey, usdtMint: mint, usdtDecimals: 6, heirloomProgram: programId,
  heirloomDiscriminators: Object.fromEntries(SPONSORED_HEIRLOOM_IXS.filter((n) => names.includes(n)).map((n) => [n, findInstruction(n).discriminator])),
  ...DEFAULT_LIMITS, sponsorPaysRent: true, ...over,
});

const ataOf = (owner: PublicKey, m = mint) => getAssociatedTokenAddressSync(m, owner, true);
const transfer = (amount = 1_000_000n, from = user.publicKey, m = mint, decimals = 6, to = recipient) =>
  createTransferCheckedInstruction(ataOf(from, m), m, ataOf(to, m), from, amount, decimals);
const createAta = (payer = sponsor.publicKey, owner = recipient, m = mint) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ataOf(owner, m), owner, m);
const heirloomIx = (name: string, keys: PublicKey[] = [user.publicKey]) => new TransactionInstruction({
  programId, keys: keys.map((k, i) => ({ pubkey: k, isSigner: i === 0, isWritable: true })),
  data: Buffer.from([...findInstruction(name).discriminator, 0, 0]),
});

function wire(ixs: TransactionInstruction[], o: { feePayer?: PublicKey; signers?: Keypair[]; signSponsor?: boolean } = {}): Uint8Array {
  const tx = new Transaction({ feePayer: o.feePayer ?? sponsor.publicKey, recentBlockhash: BLOCKHASH }).add(...ixs);
  const signers = o.signers ?? [user];
  if (o.signSponsor) tx.partialSign(sponsor, ...signers); else if (signers.length) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

function rejects(w: Uint8Array, code: RejectCode, p = policy()) {
  try {
    validateSponsoredTx(w, p);
  } catch (e) {
    expect(e).toBeInstanceOf(SponsorRejection);
    expect((e as SponsorRejection).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection ${code}`);
}

describe("sponsor policy: allowed", () => {
  it("accepts a USD₮ transfer with the sponsor as fee payer", () => {
    const d = validateSponsoredTx(wire([transfer()]), policy());
    expect(d.signers).toEqual([user.publicKey.toBase58()]);
    expect(d.feeLamports).toBe(10_000);
    expect(d.rentLamports).toBe(0);
  });

  it("accepts creating the recipient's USD₮ account with sponsor-paid rent when USD₮ goes into it", () => {
    const d = validateSponsoredTx(wire([createAta(), transfer()]), policy());
    expect(d.rentLamports).toBe(TOKEN_ACCOUNT_RENT);
  });

  it("accepts user-paid ATA creation even when the sponsor does not pay rent", () => {
    const d = validateSponsoredTx(wire([createAta(user.publicKey), transfer()]), policy({ sponsorPaysRent: false }));
    expect(d.rentLamports).toBe(0);
  });

  it("accepts allow-listed Heirloom instructions and compute-budget instructions within caps", () => {
    const d = validateSponsoredTx(wire([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      heirloomIx("submit_claim"), heirloomIx("deposit"),
    ]), policy());
    expect(d.feeLamports).toBe(10_000 + 2_000); // 200k CU × 10k µlamports = 2000 lamports priority
  });

  it("accepts a second user signer (e.g. buyer + owner) within the signer cap", () => {
    const ix = new TransactionInstruction({ programId, data: Buffer.from([...findInstruction("heartbeat").discriminator]), keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true }, { pubkey: other.publicKey, isSigner: true, isWritable: false },
    ] });
    expect(validateSponsoredTx(wire([ix], { signers: [user, other] }), policy()).signers).toHaveLength(2);
  });
});

describe("sponsor policy: rejected", () => {
  it("rejects SOL transfers from the sponsor", () => rejects(wire([SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: user.publicKey, lamports: 1_000_000 }), heirloomIx("heartbeat")]), "unknown_program"));
  it("rejects SOL transfers from the user too (System program is not allowed)", () => rejects(wire([SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: recipient, lamports: 1 }), transfer()]), "unknown_program"));
  it("rejects unknown programs", () => rejects(wire([new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) })]), "unknown_program"));
  it("rejects Token-2022 transfers", () => rejects(wire([createTransferCheckedInstruction(ataOf(user.publicKey), mint, ataOf(recipient), user.publicKey, 1n, 6, [], TOKEN_2022_PROGRAM_ID)]), "unknown_program"));
  it("rejects the wrong mint", () => rejects(wire([transfer(1n, user.publicKey, fakeMint)]), "wrong_mint"));
  it("rejects the wrong decimals", () => rejects(wire([transfer(1n, user.publicKey, mint, 9)]), "wrong_mint"));
  it("rejects a zero amount", () => rejects(wire([transfer(0n)]), "bad_token_ix"));
  it("rejects the sponsor as token authority (spending the sponsor's USD₮)", () => rejects(wire([transfer(1n, sponsor.publicKey)], { signers: [] }), "missing_signature"));
  it("rejects the sponsor as token authority even if it appears signed", () => {
    // the sponsor key in a token ix is refused before anything else about it
    rejects(wire([transfer(1n, sponsor.publicKey), heirloomIx("deposit")]), "sponsor_in_instruction");
  });
  it("rejects plain Transfer, Approve and CloseAccount token instructions", () => {
    rejects(wire([createTransferInstruction(ataOf(user.publicKey), ataOf(recipient), user.publicKey, 1n)]), "bad_token_ix");
    rejects(wire([createApproveInstruction(ataOf(user.publicKey), recipient, user.publicKey, 1n)]), "bad_token_ix");
    rejects(wire([createCloseAccountInstruction(ataOf(user.publicKey), sponsor.publicKey, user.publicKey)]), "bad_token_ix");
  });
  it("rejects multisig token authorities", () => rejects(wire([createTransferCheckedInstruction(ataOf(user.publicKey), mint, ataOf(recipient), user.publicKey, 1n, 6, [other.publicKey])], { signers: [other] }), "bad_token_ix"));
  it("rejects a token account owned by the sponsor", () => rejects(wire([createAta(user.publicKey, sponsor.publicKey)]), "sponsor_in_instruction"));
  it("rejects an ATA for another mint", () => rejects(wire([createAta(sponsor.publicKey, recipient, fakeMint), transfer()]), "wrong_mint"));
  it("rejects an ATA whose address does not match its owner", () => {
    const ix = createAta();
    ix.keys[1] = { ...ix.keys[1], pubkey: ataOf(other.publicKey) };
    rejects(wire([ix, transfer()]), "bad_ata_ix");
  });
  it("rejects sponsor-paid rent for an account that receives no USD₮", () => rejects(wire([createAta(), transfer(1n, user.publicKey, mint, 6, other.publicKey)]), "rent_not_allowed"));
  it("rejects sponsor-paid rent when rent sponsorship is off", () => rejects(wire([createAta(), transfer()]), "rent_not_allowed", policy({ sponsorPaysRent: false })));
  it("rejects more than one account creation", () => rejects(wire([createAta(), createAta(sponsor.publicKey, other.publicKey), transfer()]), "bad_ata_ix"));
  it("rejects agent-only Heirloom instructions", () => {
    for (const n of ["review_death", "review_claim", "list_asset", "accept_offer"].filter((x) => names.includes(x))) rejects(wire([heirloomIx(n)]), "bad_heirloom_ix");
  });
  it("rejects unknown Heirloom discriminators and short data", () => {
    rejects(wire([new TransactionInstruction({ programId, keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(8, 7) })]), "bad_heirloom_ix");
    rejects(wire([new TransactionInstruction({ programId, keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1, 2]) })]), "bad_heirloom_ix");
  });
  it("rejects the sponsor as an account of a Heirloom instruction (e.g. as payer)", () => rejects(wire([heirloomIx("execute_claim", [user.publicKey, sponsor.publicKey])]), "sponsor_in_instruction"));
  it("rejects a fee payer other than the sponsor", () => rejects(wire([transfer()], { feePayer: user.publicKey }), "wrong_fee_payer"));
  it("rejects a tx the sponsor already signed", () => rejects(wire([transfer()], { signSponsor: true }), "sponsor_signed"));
  it("rejects a missing user signature", () => rejects(wire([transfer()], { signers: [] }), "missing_signature"));
  it("rejects a tampered signature", () => {
    const w = wire([transfer()]);
    w[1 + 64 + 5] ^= 0xff; // second signature slot (the user's)
    rejects(w, "bad_signature");
  });
  it("rejects a message changed after signing", () => {
    const w = wire([transfer(1_000_000n)]);
    w[w.length - 2] ^= 0x01; // amount byte inside the transfer data
    rejects(w, "bad_signature");
  });
  it("rejects too many signers", () => {
    const k = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const ix = new TransactionInstruction({ programId, data: Buffer.from(findInstruction("heartbeat").discriminator), keys: k.map((x) => ({ pubkey: x.publicKey, isSigner: true, isWritable: false })) });
    rejects(wire([ix], { signers: k }), "too_many_signers");
  });
  it("rejects compute budget abuse", () => {
    rejects(wire([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), transfer()]), "bad_compute_budget");
    rejects(wire([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), transfer()]), "bad_compute_budget");
    rejects(wire([ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), transfer()]), "bad_compute_budget");
    rejects(wire([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), transfer()]), "bad_compute_budget");
  });
  it("rejects fees above the cap", () => rejects(wire([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), transfer()]), "fee_too_high", policy({ maxFeeLamports: 15_000 })));
  it("rejects a tx with only compute-budget instructions (no user to sponsor)", () => rejects(wire([ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })], { signers: [] }), "missing_signature"));
  it("rejects versioned (v0) transactions", () => {
    const msg = MessageV0.compile({ payerKey: sponsor.publicKey, recentBlockhash: BLOCKHASH, instructions: [transfer()] });
    const v = new VersionedTransaction(msg);
    v.sign([user]);
    rejects(v.serialize(), "versioned");
  });
  it("rejects garbage and oversized input", () => {
    rejects(new Uint8Array([1, 2, 3]), "malformed");
    rejects(new Uint8Array(1300), "too_large");
  });
});

describe("sponsor limiter", () => {
  it("limits per wallet per minute and per day, rent creations, and the daily budget", () => {
    const l = new SponsorLimiter({ perMinute: 2, perDay: 3, rentPerDay: 1, dailyBudgetLamports: 3_000_000, ipFeesPerDay: 10, ipRentPerDay: 10 });
    const t = 1_000_000;
    expect(l.check("a", 10_000, false, t)).toBeNull();
    l.record("a", 10_000, false, t);
    l.record("a", 10_000, false, t + 1);
    expect(l.check("a", 10_000, false, t + 2)).toMatch(/wait a minute/);
    expect(l.check("b", 10_000, false, t + 2)).toBeNull();
    l.record("a", 10_000, false, t + 61_000);
    expect(l.check("a", 10_000, false, t + 122_000)).toMatch(/today's limit/);
    l.record("c", TOKEN_ACCOUNT_RENT, true, t);
    expect(l.check("c", TOKEN_ACCOUNT_RENT, true, t + 120_000)).toMatch(/new accounts/);
    expect(l.check("d", 1_000_000, false, t)).toMatch(/budget/);
    expect(l.check("a", 10_000, false, t + 86_400_000 + 1)).toBeNull(); // next day
  });
});

describe("ATA program id sanity", () => {
  it("uses the classic ATA program", () => expect(createAta().programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true));
  it("uses the classic token program", () => expect(transfer().programId.equals(TOKEN_PROGRAM_ID)).toBe(true));
});

describe("guardians instructions (docs/guardians-spec.md §2.2)", () => {
  const USER = ["init_guard", "init_seat", "set_seat_backups", "set_seat_monitors", "set_fallback", "owner_replace_seat",
    "report_seat_death", "confirm_seat_death", "veto_seat_death", "finalize_succession", "raise_objection", "vote_objection",
    "set_asset_media", "report_fallback_death", "start_fallback", "execute_fallback", "lapse_objection"];
  const AGENT = ["review_seat_death", "review_fallback_death"];

  it("sponsors every family / trusted-person / monitor instruction, never the agent's reviews", () => {
    for (const n of USER) expect(SPONSORED_HEIRLOOM_IXS).toContain(n);
    for (const n of AGENT) expect(SPONSORED_HEIRLOOM_IXS).not.toContain(n);
  });

  it("lets the agent sign only the two death-certificate reviews of the new instructions", () => {
    for (const n of AGENT) expect(AGENT_ALLOWED).toContain(n);
    for (const n of USER) expect(AGENT_ALLOWED).not.toContain(n);
  });

  it("accepts the new user instructions and rejects the agent reviews (once they are in the IDL)", () => {
    for (const n of USER.filter((x) => names.includes(x))) expect(validateSponsoredTx(wire([heirloomIx(n)]), policy()).summary).toEqual([`heirloom ${n}`]);
    for (const n of AGENT.filter((x) => names.includes(x))) rejects(wire([heirloomIx(n)]), "bad_heirloom_ix");
  });
});

describe("sponsor as rent payer of the approval stamp (approve_claim)", () => {
  const idx = getIdl().instructions.find((i) => i.name === "approve_claim")!.accounts.findIndex((a) => a.name === "payer");
  const withSlot = (over: Partial<SponsorPolicy> = {}) => policy({ heirloomRentPayerSlots: { approve_claim: idx }, ...over });
  const approve = (payer: PublicKey) => {
    const keys = Array.from({ length: Math.max(idx + 1, 2) }, (_, i) => (i === 0 ? user.publicKey : i === idx ? payer : Keypair.generate().publicKey));
    return new TransactionInstruction({
      programId, keys: keys.map((k, i) => ({ pubkey: k, isSigner: i === 0 || i === idx, isWritable: i === idx })),
      data: Buffer.from(findInstruction("approve_claim").discriminator),
    });
  };

  it("allows the sponsor in the payer slot and counts the stamp rent", () => {
    expect(idx).toBeGreaterThan(0);
    const d = validateSponsoredTx(wire([approve(sponsor.publicKey)]), withSlot());
    expect(d.rentLamports).toBe(APPROVAL_STAMP_RENT);
  });
  it("still refuses the sponsor in any other slot or instruction", () => {
    rejects(wire([approve(sponsor.publicKey)]), "sponsor_in_instruction"); // no slot configured
    rejects(wire([heirloomIx("execute_claim", [user.publicKey, sponsor.publicKey])]), "sponsor_in_instruction", withSlot());
  });
  it("refuses when rent sponsorship is off, and more than one sponsored stamp per tx", () => {
    rejects(wire([approve(sponsor.publicKey)]), "rent_not_allowed", withSlot({ sponsorPaysRent: false }));
    rejects(wire([approve(sponsor.publicKey), approve(sponsor.publicKey)]), "rent_not_allowed", withSlot());
  });
  it("needs no rent when the verifier pays", () => {
    expect(validateSponsoredTx(wire([approve(user.publicKey)]), withSlot()).rentLamports).toBe(0);
  });
});

describe("permissionless instructions with a signing caller (finalize_succession, start_fallback, finalize_unlock, lapse_objection)", () => {
  const ctx: ix.Ctx = { programId, usdtMint: mint };
  const estate = estatePda(programId, Keypair.generate().publicKey);
  const build = (caller: PublicKey) => [
    ix.finalizeSuccession(ctx, estate, 2, caller), ix.startFallback(ctx, estate, caller),
    ix.finalizeUnlock(estate, caller), ix.lapseObjection(ctx, estate, caller),
  ];

  it("are sponsored when any wallet signs as the caller (real IDL accounts)", () => {
    for (const i of build(user.publicKey)) {
      const d = validateSponsoredTx(wire([i]), policy());
      expect(d.signers).toEqual([user.publicKey.toBase58()]);
      expect(d.rentLamports).toBe(0);
      expect(d.summary[0]).toMatch(/^heirloom (finalize_succession|start_fallback|finalize_unlock|lapse_objection)$/);
    }
  });

  it("refuse the sponsor as the caller: it may only ever be the fee payer", () => {
    for (const i of build(sponsor.publicKey)) rejects(wire([i], { signers: [] }), "missing_signature");
    // Even with another signer present, the sponsor's key inside the instruction is refused.
    for (const i of build(sponsor.publicKey)) rejects(wire([i, transfer()]), "sponsor_in_instruction");
  });

  it("refuse an unsigned call (the old account list): nobody to check or rate-limit", () => {
    for (const i of build(user.publicKey)) {
      i.keys.forEach((k) => { k.isSigner = false; });
      rejects(wire([i], { signers: [] }), "missing_signature");
    }
  });
});

describe("second security review (22 Nov 2026)", () => {
  const ctx: ix.Ctx = { programId, usdtMint: mint };
  const k = () => Keypair.generate().publicKey;
  const [u, nft, asset] = [user.publicKey, k(), k()];
  const estate = estatePda(programId, u);
  const H = "ab".repeat(32);
  const payerSlot = findInstruction("approve_claim").accounts.findIndex((a) => a.name === "payer");
  const hardshipPayerSlot = findInstruction("approve_hardship").accounts.findIndex((a) => a.name === "payer");
  /** As the server reads them: SPONSOR_RENT_PAYER_ACCOUNTS against the IDL. */
  const rentSlots = Object.fromEntries(Object.entries(SPONSOR_RENT_PAYER_ACCOUNTS).map(([n, a]) => [n, findInstruction(n).accounts.findIndex((x) => x.name === a)]));
  const withSlot = policy({ heirloomRentPayerSlots: rentSlots });
  const rentSlot: Record<string, number> = { approve_claim: payerSlot, approve_hardship: hardshipPayerSlot };
  /** The new and changed instructions, as the app builds them. */
  const built: Record<string, () => TransactionInstruction> = {
    report_fallback_death: () => ix.reportFallbackDeath(ctx, u, estate, 1, H, { monitorSeat: 0, beneficiary: true }),
    resolve_fallback_death: () => ix.resolveFallbackDeath(ctx, { signer: u, estate, index: 1, dead: false, rentTo: k(), as: { monitorSeat: 0, beneficiary: true } }),
    release_asset: () => ix.releaseAsset(ctx, u, asset, nft),
    remove_member: () => ix.removeMember(ctx, u, { beneficiary: k(), payee: k() }),
    add_rule_v2: () => ix.addRule(ctx, u, { ruleId: 1, beneficiaryWallet: k(), category: "Books", allowedPayeeKind: "School", maxPerClaim: 1n, lifetimeCap: 2n, validUntil: 2e9 }),
    submit_death_claim: () => ix.submitDeathClaim(ctx, estate, u, H, { listed: true }),
    set_seat_monitors: () => ix.setSeatMonitors(ctx, u, 1, [k()]),
    set_fallback: () => ix.setFallback(ctx, u, [k(), k()]),
    owner_replace_seat: () => ix.ownerReplaceSeat(ctx, u, 1, k()),
    raise_dispute: () => ix.raiseDispute(ctx, { disputer: u, estate, kind: "Unlock", target: estate, reasonHashHex: H, beneficiary: true }),
    approve_hardship: () => ix.approveHardship(estate, u, asset, k()),
    report_seat_death: () => ix.reportSeatDeath(ctx, u, estate, 1, H, { beneficiary: true }),
    confirm_seat_death: () => ix.confirmSeatDeath(ctx, u, estate, 1, { beneficiary: true }),
    finalize_succession: () => ix.finalizeSuccession(ctx, estate, 1, u),
    vote_objection: () => ix.voteObjection(ctx, { voter: u, estate, kind: "Fallback", target: k(), uphold: true }),
    execute_claim: () => ix.executeClaim(ctx, { estate, payer: u, rule: k(), claim: k(), beneficiary: k(), payeeWallet: k() }),
    execute_scheduled: () => ix.executeScheduled(ctx, { estate, payer: u, rule: k(), beneficiary: k(), payeeWallet: k() }),
    execute_fallback: () => ix.executeFallback(ctx, { payer: u, estate, recipient: k(), recipientIndex: 0 }),
    sweep_residual: () => ix.sweepResidual(ctx, { payer: u, estate, recipient: k(), reportIndex: 255, rules: [k(), k()] }),
    withdraw_offer: () => ix.withdrawOffer(ctx, estate, asset, u),
    set_agent: () => ix.setAgent(ctx, u, k()),
    vote_agent: () => ix.voteAgent(ctx, estate, u, k()),
    approve_claim: () => ix.approveClaim(estate, u, k(), k()),
  };

  it.each(Object.keys(built))("%s: fits one sponsored transaction with its compute budget", (name) => {
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 })];
    expect(txBytes([...budget, built[name]()], sponsor.publicKey)).toBeLessThanOrEqual(1232);
  });

  it.each(Object.keys(built))("%s: sponsored, with no rent from the sponsor", (name) => {
    expect(SPONSORED_HEIRLOOM_IXS).toContain(name);
    expect(validateSponsoredTx(wire([built[name]()]), withSlot)).toMatchObject({ rentLamports: 0, summary: [`heirloom ${name}`] });
  });

  // Reporter, rent_to, payer, close destination, optional and remaining accounts: every slot of every one.
  it.each(Object.keys(built))("%s: the sponsor can be none of its accounts", (name) => {
    const original = built[name]();
    original.keys.forEach((meta, i) => {
      if (rentSlot[name] === i) return;
      const t = new TransactionInstruction({
        programId, data: original.data,
        keys: original.keys.map((m, j) => (j === i ? { ...m, pubkey: sponsor.publicKey } : m)),
      });
      // Another instruction keeps the user a signer, whichever slot the sponsor took.
      rejects(wire([t, heirloomIx("heartbeat")]), "sponsor_in_instruction", withSlot);
      expect(meta.pubkey.equals(sponsor.publicKey)).toBe(false);
    });
  });

  it("never a reporter's rent: report_fallback_death has no rent slot", () => {
    const t = ix.reportFallbackDeath(ctx, sponsor.publicKey, estate, 1, H);
    rejects(wire([t, heirloomIx("heartbeat")]), "sponsor_in_instruction", withSlot);
  });

  it("a co-signed sale is never a sponsored transaction", () => {
    rejects(wire([ix.acceptOffer(ctx, { estate, agent: k(), asset, nftMint: nft, buyer: k(), recipient: k(), expectedAmount: 1n, coSigner: u })], { signers: [] }), "missing_signature");
    expect(SPONSORED_HEIRLOOM_IXS).not.toContain("accept_offer");
  });

  it("the agent's reviews stay out, the owner's photos stay in", () => {
    for (const n of AGENT_ALLOWED.filter((x) => x !== "execute_scheduled")) expect(SPONSORED_HEIRLOOM_IXS).not.toContain(n);
    expect(SPONSORED_HEIRLOOM_IXS).toContain("set_asset_media");
  });

  it("rent for one account in a transaction: not a stamp and a token account together", () => {
    const stamp = built.approve_claim();
    stamp.keys[payerSlot] = { ...stamp.keys[payerSlot], pubkey: sponsor.publicKey };
    rejects(wire([stamp, createAta(), transfer()]), "rent_not_allowed", withSlot);
  });

  it("approve_hardship: the sponsor may pay its stamp's rent as for approve_claim, one rent per transaction", () => {
    expect(rentSlots).toEqual({ approve_claim: payerSlot, approve_hardship: hardshipPayerSlot });
    const sponsored = (t: TransactionInstruction, at: number) => {
      t.keys[at] = { ...t.keys[at], pubkey: sponsor.publicKey };
      return t;
    };
    const hardship = () => sponsored(built.approve_hardship(), hardshipPayerSlot);
    expect(validateSponsoredTx(wire([hardship()]), withSlot)).toMatchObject({ rentLamports: APPROVAL_STAMP_RENT, summary: ["heirloom approve_hardship (stamp rent sponsored)"] });
    rejects(wire([hardship()]), "rent_not_allowed", policy({ heirloomRentPayerSlots: rentSlots, sponsorPaysRent: false }));
    rejects(wire([hardship(), sponsored(built.approve_claim(), payerSlot)]), "rent_not_allowed", withSlot);
    rejects(wire([hardship(), createAta(), transfer()]), "rent_not_allowed", withSlot);
    // Its verifier stays in their own slot: the sponsor there is refused.
    rejects(wire([sponsored(built.approve_hardship(), 0), heirloomIx("heartbeat")]), "sponsor_in_instruction", withSlot);
  });
});

describe("instruction names the IDL may change (plan §18.10 C1)", () => {
  it("whatever add_rule is called in the IDL is built and sponsored", () => {
    expect(names).toContain(ix.addRuleIx());
    expect(Object.keys(policy().heirloomDiscriminators)).toContain(ix.addRuleIx());
  });
});

describe("disputes and yearly caps (15 Nov 2026)", () => {
  const USER = ["raise_dispute", "resolve_dispute", "set_yearly_cap"];
  it("are sponsored family / trusted-person / owner instructions, never signed by the agent", () => {
    for (const n of USER) {
      expect(SPONSORED_HEIRLOOM_IXS).toContain(n);
      expect(AGENT_ALLOWED).not.toContain(n);
      expect(names).toContain(n);
      expect(validateSponsoredTx(wire([heirloomIx(n)]), policy()).summary).toEqual([`heirloom ${n}`]);
    }
  });
  it("still refuse the sponsor inside them (no rent slot)", () => {
    for (const n of USER) rejects(wire([heirloomIx(n, [user.publicKey, sponsor.publicKey])]), "sponsor_in_instruction");
  });
});
