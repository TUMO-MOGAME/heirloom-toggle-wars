/**
 * Instruction builders for every instruction in docs/program-spec.md.
 *
 * Accounts are resolved from the IDL by name: each builder supplies the addresses it knows under a few
 * likely names (e.g. the owner's USD₮ account as owner_token / owner_ata / owner_usdt), and the IDL's
 * own account list decides order, signer and writable flags. Args are passed positionally in spec
 * order and mapped onto the IDL's arg names. This keeps the client correct even if the contract
 * author picks slightly different account/arg names, and fails loudly (naming the missing account)
 * if something is genuinely missing.
 */
import { BN } from "@anchor-lang/core";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import type { Category, PayeeKind } from "../types";
import { enumValue, findInstruction, getCoder, getIdl, norm } from "./idl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
  assetPda, ata, beneficiaryPda, claimPda, estatePda, hardshipPda, nftEscrowAta, offerEscrowAta, offerPda,
  payeePda, rulePda, vaultAta, guardPda, mediaPda, objectionPda, seatPda, stampPda, yearCapPda,
  agentVotePda, fallbackReportPda, residualPda,
} from "./pda";
import type { AssetKind, TargetKind } from "../guardians/types";
import type { ReviewOutcome } from "../verdict";

const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");

/** name (any case/underscore style) → address. Several names may map to the same address. */
export type KnownAccounts = Record<string, PublicKey>;

function programAccounts(): KnownAccounts {
  return {
    system_program: SYSTEM_PROGRAM_ID,
    token_program: TOKEN_PROGRAM_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    rent: RENT_SYSVAR,
  };
}

type IdlAccountItem = ReturnType<typeof findInstruction>["accounts"][number];
interface FlatAccount { name: string; writable: boolean; signer: boolean; optional: boolean; address?: string }

function flatten(items: IdlAccountItem[]): FlatAccount[] {
  const out: FlatAccount[] = [];
  for (const it of items) {
    if ("accounts" in it) out.push(...flatten(it.accounts));
    else out.push({ name: it.name, writable: !!it.writable, signer: !!it.signer, optional: !!it.optional, address: it.address });
  }
  return out;
}

export function resolveAccountMetas(ixName: string, known: KnownAccounts, programId: PublicKey): AccountMeta[] {
  const ix = findInstruction(ixName);
  const lookup = new Map<string, PublicKey>();
  for (const [k, v] of Object.entries({ ...programAccounts(), ...known })) lookup.set(norm(k), v);
  const missing: string[] = [];
  const metas = flatten(ix.accounts).map((a): AccountMeta => {
    const pubkey = a.address ? new PublicKey(a.address) : lookup.get(norm(a.name));
    if (!pubkey) {
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false }; // Anchor's "None"
      missing.push(a.name);
      return { pubkey: PublicKey.default, isSigner: false, isWritable: false };
    }
    return { pubkey, isSigner: a.signer, isWritable: a.writable };
  });
  if (missing.length) {
    throw new Error(`Cannot build ${ixName}: no address for account(s) ${missing.join(", ")}. Update chain/instructions.ts aliases to match the IDL.`);
  }
  return metas;
}

export function buildIx(ixName: string, positionalArgs: unknown[], known: KnownAccounts): TransactionInstruction {
  const idl = getIdl();
  const programId = new PublicKey(idl.address);
  const ix = findInstruction(ixName);
  if (ix.args.length !== positionalArgs.length) {
    throw new Error(`${ixName}: IDL expects ${ix.args.length} args, client passed ${positionalArgs.length}. IDL and spec disagree.`);
  }
  const args: Record<string, unknown> = {};
  ix.args.forEach((a, i) => { args[a.name] = positionalArgs[i]; });
  const data = getCoder().instruction.encode(ix.name, args);
  return new TransactionInstruction({ programId, keys: resolveAccountMetas(ixName, known, programId), data });
}

// ---------- value helpers ----------
export const u64 = (v: bigint | number) => new BN(v.toString());
export const i64 = (v: number) => new BN(Math.trunc(v).toString());
export function hash32(hex: string): number[] {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("Expected a 64-char hex sha256 hash");
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}
const cat = (c: Category) => enumValue("Category", c);
const kind = (k: PayeeKind) => enumValue("PayeeKind", k);
const outcomeArg = (o: ReviewOutcome) => enumValue("ReviewOutcome", o);

// ---------- context ----------
export interface Ctx { programId: PublicKey; usdtMint: PublicKey }

function estateAccounts(ctx: Ctx, owner: PublicKey) {
  const estate = estatePda(ctx.programId, owner);
  const vault = vaultAta(ctx.usdtMint, estate);
  return { estate, vault, estate_vault: vault, vault_ata: vault, usdt_mint: ctx.usdtMint, mint: ctx.usdtMint };
}

// ---------- builders (spec §Instructions, numbered as in the spec) ----------

/** 1 */
export function createEstate(ctx: Ctx, p: {
  owner: PublicKey; agent: PublicKey; verifiers: [PublicKey, PublicKey, PublicKey];
  deathThreshold: number; claimThreshold: number; hardshipThreshold: number; waitingPeriodSecs: number;
}) {
  return buildIx("create_estate",
    [p.agent, p.verifiers, p.deathThreshold, p.claimThreshold, p.hardshipThreshold, i64(p.waitingPeriodSecs)],
    { owner: p.owner, ...estateAccounts(ctx, p.owner) });
}

/** 2 */
export function setWill(ctx: Ctx, owner: PublicKey, willHashHex: string, willUri: string) {
  return buildIx("set_will", [hash32(willHashHex), willUri], { owner, ...estateAccounts(ctx, owner) });
}

/** 3 */
export function addBeneficiary(ctx: Ctx, owner: PublicKey, wallet: PublicKey, label: string) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("add_beneficiary", [label],
    { owner, estate, wallet, beneficiary_wallet: wallet, beneficiary: beneficiaryPda(ctx.programId, estate, wallet) });
}

/** 4 */
export function addPayee(ctx: Ctx, owner: PublicKey, wallet: PublicKey, k: PayeeKind, name: string) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("add_payee", [kind(k), name],
    { owner, estate, wallet, payee_wallet: wallet, payee: payeePda(ctx.programId, estate, wallet) });
}

/**
 * add_rule's name in the bundled IDL. The program renames it add_rule_v2 (plan §18.10 C1), so a client built for the
 * old argument list fails on the new program instead of shifting every value; whichever the IDL has is the one built.
 */
export const addRuleIx = (): string => (getIdl().instructions.some((i) => i.name === "add_rule_v2") ? "add_rule_v2" : "add_rule");

/**
 * 5. `ruleId`: the estate's current rule_count for a new slot, or the id of an ended rule whose slot is reused (its
 * yearly cap then closes to the owner).
 * Living plans: `startsNow` lets the rule pay while the owner is alive; `recurring` makes it a scheduled payment
 * (fixed amount to a fixed payee every interval, first at `firstDue`).
 */
export function addRule(ctx: Ctx, owner: PublicKey, p: {
  ruleId: number; beneficiaryWallet: PublicKey; category: Category; allowedPayeeKind: PayeeKind;
  maxPerClaim: bigint; lifetimeCap: bigint; validUntil: number;
  startsNow?: boolean; recurring?: { amount: bigint; intervalSecs: number; firstDue: number; payeeWallet: PublicKey };
}) {
  const { estate } = estateAccounts(ctx, owner);
  const args = [
    p.ruleId, cat(p.category), kind(p.allowedPayeeKind), u64(p.maxPerClaim), u64(p.lifetimeCap), i64(p.validUntil),
    !!p.startsNow, u64(p.recurring?.amount ?? 0n), i64(p.recurring?.intervalSecs ?? 0), i64(p.recurring?.firstDue ?? 0),
  ];
  const rule = rulePda(ctx.programId, estate, p.ruleId);
  return buildIx(addRuleIx(), args, {
    owner, estate, rule, year_cap: yearCapPda(ctx.programId, rule),
    beneficiary: beneficiaryPda(ctx.programId, estate, p.beneficiaryWallet),
    ...(p.recurring ? { payee: payeePda(ctx.programId, estate, p.recurring.payeeWallet) } : {}),
  });
}

function ownerTokenAccounts(ctx: Ctx, owner: PublicKey) {
  const t = ata(ctx.usdtMint, owner);
  return { owner_token: t, owner_ata: t, owner_usdt: t, owner_token_account: t, owner_usdt_ata: t };
}

/** 6 */
export function deposit(ctx: Ctx, owner: PublicKey, amount: bigint) {
  return buildIx("deposit", [u64(amount)], { owner, ...estateAccounts(ctx, owner), ...ownerTokenAccounts(ctx, owner) });
}

/** 7 */
export function withdraw(ctx: Ctx, owner: PublicKey, amount: bigint) {
  return buildIx("withdraw", [u64(amount)], { owner, ...estateAccounts(ctx, owner), ...ownerTokenAccounts(ctx, owner) });
}

/** 8 */
export function heartbeat(ctx: Ctx, owner: PublicKey) {
  return buildIx("heartbeat", [], { owner, ...estateAccounts(ctx, owner) });
}

/** 9 */
export function registerAsset(ctx: Ctx, owner: PublicKey, p: {
  nftMint: PublicKey; floorPrice: bigint; hardshipFloor: bigint; askingPrice: bigint; proceedsTo: PublicKey; docHashHex: string;
}) {
  const { estate } = estateAccounts(ctx, owner);
  const ownerNft = ata(p.nftMint, owner);
  const escrow = nftEscrowAta(p.nftMint, estate);
  return buildIx("register_asset",
    [u64(p.floorPrice), u64(p.hardshipFloor), u64(p.askingPrice), p.proceedsTo, hash32(p.docHashHex)],
    {
      owner, estate, nft_mint: p.nftMint, asset: assetPda(ctx.programId, estate, p.nftMint),
      owner_nft: ownerNft, owner_nft_ata: ownerNft, owner_nft_account: ownerNft,
      nft_escrow: escrow, escrow_nft: escrow, nft_vault: escrow,
    });
}

/**
 * Accounts for a beneficiary signer acting on an estate. In these instructions the IDL names the signing
 * wallet `beneficiary` and the Beneficiary PDA `beneficiary_account` (unlike add_rule, where `beneficiary`
 * is the PDA), so both spellings are mapped here.
 */
function beneficiarySigner(ctx: Ctx, estate: PublicKey, signer: PublicKey) {
  const pda = beneficiaryPda(ctx.programId, estate, signer);
  return {
    beneficiary: signer, signer, beneficiary_wallet: signer, claimant: signer, submitter: signer, authority: signer,
    beneficiary_account: pda, beneficiary_pda: pda, estate,
  };
}

/** Who reports the owner's death: an active beneficiary (their PDA), a living listed fallback recipient (the Guard), else a trusted person. */
export interface DeathReporter { beneficiary?: boolean; listed?: boolean }

/**
 * 10. An active beneficiary (the default), a living trusted person (`{}`) or a living listed fallback recipient
 * (`{ listed: true }`); never the agent. An optional account that is passed must exist, so only the one the signer
 * holds is passed. The ["objection", estate] PDA: a challenge to the claim this one replaces is voided.
 */
export function submitDeathClaim(ctx: Ctx, estate: PublicKey, signer: PublicKey, certHashHex: string, as: DeathReporter = { beneficiary: true }) {
  return buildIx("submit_death_claim", [hash32(certHashHex)], {
    beneficiary: signer, estate,
    ...(as.beneficiary ? { beneficiary_account: beneficiaryPda(ctx.programId, estate, signer) } : {}),
    ...(as.listed ? { guard: guardPda(ctx.programId, estate) } : {}),
    objection: objectionPda(ctx.programId, estate),
  });
}

/** 11 (agent). `certHashHex`: the hash of the file the agent read (ReportChanged if another report replaced it). */
export function reviewDeath(estate: PublicKey, agent: PublicKey, outcome: ReviewOutcome, reportHashHex: string, certHashHex: string) {
  return buildIx("review_death", [outcomeArg(outcome), hash32(reportHashHex), hash32(certHashHex)], { agent, estate });
}

/** 12 */
export function attestDeath(estate: PublicKey, verifier: PublicKey) {
  return buildIx("attest_death", [], { verifier, estate });
}

/** 13 */
export function vetoDeath(ctx: Ctx, owner: PublicKey) {
  return buildIx("veto_death", [], { owner, ...estateAccounts(ctx, owner) });
}

/** 14 */
export function finalizeUnlock(estate: PublicKey, signer: PublicKey) {
  const programId = new PublicKey(getIdl().address);
  return buildIx("finalize_unlock", [], {
    signer, payer: signer, caller: signer, authority: signer, estate, objection: objectionPda(programId, estate),
  });
}

/** 15. `claimId` must be the rule's current claim_count. */
export function submitClaim(ctx: Ctx, p: {
  estate: PublicKey; signer: PublicKey; ruleId: number; claimId: number; payeeWallet: PublicKey; amount: bigint; evidenceHashHex: string;
}) {
  const rule = rulePda(ctx.programId, p.estate, p.ruleId);
  return buildIx("submit_claim", [u64(p.amount), hash32(p.evidenceHashHex)], {
    ...beneficiarySigner(ctx, p.estate, p.signer), rule,
    payee: payeePda(ctx.programId, p.estate, p.payeeWallet), payee_wallet: p.payeeWallet,
    claim: claimPda(ctx.programId, rule, p.claimId),
    year_cap: yearCapPda(ctx.programId, rule), // may not exist (no yearly cap)
  });
}

/** 16 (agent) */
export function reviewClaim(estate: PublicKey, agent: PublicKey, claim: PublicKey, rule: PublicKey, outcome: ReviewOutcome, reportHashHex: string) {
  return buildIx("review_claim", [outcomeArg(outcome), hash32(reportHashHex)], { agent, estate, claim, rule });
}

/** 17 */
export function approveClaim(estate: PublicKey, verifier: PublicKey, claim: PublicKey, rule: PublicKey) {
  // Guardians: the approval that reaches the threshold writes the ["stamp", claim] PDA (rent paid by the verifier;
  // the fee sponsor may never be an account of a Heirloom instruction).
  const programId = new PublicKey(getIdl().address);
  return buildIx("approve_claim", [], { verifier, payer: verifier, estate, claim, rule, approval_stamp: stampPda(programId, claim) });
}

/** 18. `beneficiary` = claim.beneficiary, `payeeWallet` = claim.payee: both must still be in the plan. */
export function executeClaim(ctx: Ctx, p: { estate: PublicKey; payer: PublicKey; rule: PublicKey; claim: PublicKey; beneficiary: PublicKey; payeeWallet: PublicKey }) {
  const payeeToken = ata(ctx.usdtMint, p.payeeWallet);
  const vault = vaultAta(ctx.usdtMint, p.estate);
  return buildIx("execute_claim", [], {
    payer: p.payer, signer: p.payer, caller: p.payer, authority: p.payer,
    estate: p.estate, rule: p.rule, claim: p.claim,
    payee_account: payeePda(ctx.programId, p.estate, p.payeeWallet), payee_wallet: p.payeeWallet,
    beneficiary_account: beneficiaryPda(ctx.programId, p.estate, p.beneficiary),
    payee_token: payeeToken, payee_ata: payeeToken, payee_usdt: payeeToken, payee_token_account: payeeToken,
    usdt_mint: ctx.usdtMint, mint: ctx.usdtMint, vault, estate_vault: vault, vault_ata: vault,
    // Guardians (may not exist; the program checks): objection window and objections.
    guard: guardPda(ctx.programId, p.estate), approval_stamp: stampPda(ctx.programId, p.claim), objection: objectionPda(ctx.programId, p.claim),
    year_cap: yearCapPda(ctx.programId, p.rule), // may not exist (no yearly cap)
  });
}

/** Living plan: the owner approves a claim on a starts_now rule while alive. */
export function ownerApproveClaim(ctx: Ctx, owner: PublicKey, claim: PublicKey, rule: PublicKey) {
  return buildIx("owner_approve_claim", [], { owner, ...estateAccounts(ctx, owner), claim, rule });
}

/** Scheduled payment: anyone (agent scheduler, UI button) pays a due recurring rule to its fixed payee. `beneficiary` = rule.beneficiary. */
export function executeScheduled(ctx: Ctx, p: { estate: PublicKey; payer: PublicKey; rule: PublicKey; beneficiary: PublicKey; payeeWallet: PublicKey }) {
  const payeeToken = ata(ctx.usdtMint, p.payeeWallet);
  const vault = vaultAta(ctx.usdtMint, p.estate);
  const payee = payeePda(ctx.programId, p.estate, p.payeeWallet);
  return buildIx("execute_scheduled", [], {
    payer: p.payer, signer: p.payer, caller: p.payer, authority: p.payer, cranker: p.payer,
    estate: p.estate, rule: p.rule, payee_account: payee, payee_wallet: p.payeeWallet,
    beneficiary_account: beneficiaryPda(ctx.programId, p.estate, p.beneficiary),
    payee_token: payeeToken, payee_ata: payeeToken, payee_usdt: payeeToken, payee_token_account: payeeToken,
    usdt_mint: ctx.usdtMint, mint: ctx.usdtMint, vault, estate_vault: vault, vault_ata: vault,
    year_cap: yearCapPda(ctx.programId, p.rule), // may not exist (no yearly cap)
  });
}

/** 19 (agent or verifier) */
export function listAsset(estate: PublicKey, authority: PublicKey, asset: PublicKey, durationSecs: number) {
  return buildIx("list_asset", [i64(durationSecs)], { authority, signer: authority, agent: authority, estate, asset });
}

function offerAccounts(ctx: Ctx, estate: PublicKey, asset: PublicKey, buyer: PublicKey) {
  const offer = offerPda(ctx.programId, asset, buyer);
  const escrow = offerEscrowAta(ctx.usdtMint, offer);
  const buyerToken = ata(ctx.usdtMint, buyer);
  return {
    buyer, estate, asset, offer, usdt_mint: ctx.usdtMint, mint: ctx.usdtMint,
    offer_escrow: escrow, escrow, offer_vault: escrow,
    buyer_token: buyerToken, buyer_ata: buyerToken, buyer_usdt: buyerToken, buyer_token_account: buyerToken,
  };
}

/** 20 */
export function placeOffer(ctx: Ctx, estate: PublicKey, asset: PublicKey, buyer: PublicKey, amount: bigint) {
  return buildIx("place_offer", [u64(amount)], offerAccounts(ctx, estate, asset, buyer));
}

/** 21 */
export function withdrawOffer(ctx: Ctx, estate: PublicKey, asset: PublicKey, buyer: PublicKey) {
  return buildIx("withdraw_offer", [], offerAccounts(ctx, estate, asset, buyer));
}

/** 22 */
export function submitHardship(ctx: Ctx, estate: PublicKey, asset: PublicKey, signer: PublicKey, evidenceHashHex: string) {
  return buildIx("submit_hardship", [hash32(evidenceHashHex)], {
    ...beneficiarySigner(ctx, estate, signer), asset, hardship: hardshipPda(ctx.programId, asset, signer),
  });
}

/** 23 (agent) */
export function reviewHardship(estate: PublicKey, agent: PublicKey, asset: PublicKey, hardship: PublicKey, outcome: ReviewOutcome, reportHashHex: string) {
  return buildIx("review_hardship", [outcomeArg(outcome), hash32(reportHashHex)], { agent, estate, asset, hardship });
}

/** 24 */
export function approveHardship(estate: PublicKey, verifier: PublicKey, asset: PublicKey, hardship: PublicKey) {
  // The approval writes the ["stamp", hardship] PDA (the quorum's time, for the objection window before a sale). The
  // verifier pays its rent; the service may hand that slot to the sponsor, as for approve_claim.
  const programId = new PublicKey(getIdl().address);
  return buildIx("approve_hardship", [], { verifier, payer: verifier, estate, asset, hardship, approval_stamp: stampPda(programId, hardship) });
}

/**
 * 25 (agent, and the trusted person who co-signs). `recipient` = hardship beneficiary if set, else asset.proceeds_to.
 * `expectedAmount`: the offer both of them agreed to (OfferChanged). `coSigner` null only when no seat has a holder.
 * When a hardship stands, `hardship_objection` and `hardship_stamp` are its ["objection"] and ["stamp"] PDAs. Otherwise
 * the program reads neither and both are the system program: a fixed account already in the message, so no extra bytes.
 */
export function acceptOffer(ctx: Ctx, p: {
  estate: PublicKey; agent: PublicKey; asset: PublicKey; nftMint: PublicKey; buyer: PublicKey; recipient: PublicKey;
  expectedAmount: bigint; coSigner: PublicKey | null;
  /** asset.hardship_beneficiary, when a hardship sale is approved: its hardship's objection is checked too. */
  hardshipBeneficiary?: PublicKey | null;
}) {
  const o = offerAccounts(ctx, p.estate, p.asset, p.buyer);
  const recipientToken = ata(ctx.usdtMint, p.recipient);
  const escrowNft = nftEscrowAta(p.nftMint, p.estate);
  const buyerNft = ata(p.nftMint, p.buyer);
  const standing = p.hardshipBeneficiary ? hardshipPda(ctx.programId, p.asset, p.hardshipBeneficiary) : null;
  return buildIx("accept_offer", [u64(p.expectedAmount)], {
    ...o, agent: p.agent, nft_mint: p.nftMint,
    ...(p.coSigner ? { co_signer: p.coSigner } : {}),
    recipient: p.recipient, proceeds_to: p.recipient, recipient_wallet: p.recipient,
    recipient_token: recipientToken, recipient_ata: recipientToken, recipient_usdt: recipientToken, proceeds_token: recipientToken,
    nft_escrow: escrowNft, escrow_nft: escrowNft, nft_vault: escrowNft,
    buyer_nft: buyerNft, buyer_nft_ata: buyerNft, buyer_nft_account: buyerNft,
    objection: objectionPda(ctx.programId, p.asset),
    hardship_objection: standing ? objectionPda(ctx.programId, standing) : SYSTEM_PROGRAM_ID,
    hardship_stamp: standing ? stampPda(ctx.programId, standing) : SYSTEM_PROGRAM_ID,
    // May not exist. With a Guard the offer, and a hardship's quorum, wait out the objection window.
    guard: guardPda(ctx.programId, p.estate),
  });
}

// ---------- guardians (docs/guardians-spec.md §2.2) ----------

const NO_SEAT = 255;
const ZERO_KEY = PublicKey.default;
/** Pads a list of keys to a fixed-size array with Pubkey::default(). */
export function keyArray(keys: PublicKey[], n: number): PublicKey[] {
  if (keys.length > n) throw new Error(`At most ${n} entries.`);
  return [...keys, ...Array.from({ length: n - keys.length }, () => ZERO_KEY)];
}
const targetKind = (k: TargetKind) => enumValue("TargetKind", k);
const assetKind = (k: AssetKind) => enumValue("AssetKind", k);

function seatAccounts(ctx: Ctx, estate: PublicKey) {
  const [seat0, seat1, seat2] = [0, 1, 2].map((i) => seatPda(ctx.programId, estate, i));
  return { seat0, seat1, seat2 };
}

/** The four ["fallbackreport", estate, i] PDAs (may not exist): an owner's change voids, or a new agent sets back, the open ones. */
function fallbackReportAccounts(ctx: Ctx, estate: PublicKey) {
  const [fallback_report0, fallback_report1, fallback_report2, fallback_report3] = [0, 1, 2, 3].map((i) => fallbackReportPda(ctx.programId, estate, i));
  return { fallback_report0, fallback_report1, fallback_report2, fallback_report3 };
}

/** Owner: creates the Guard with its three timings (never the agent: they cannot be changed later). */
export function initGuard(ctx: Ctx, authority: PublicKey, estate: PublicKey, t: { objectionWindowSecs: number; successionWaitSecs: number; fallbackWaitSecs: number }) {
  return buildIx("init_guard", [i64(t.objectionWindowSecs), i64(t.successionWaitSecs), i64(t.fallbackWaitSecs)],
    { authority, payer: authority, estate, guard: guardPda(ctx.programId, estate) });
}

/** Owner: creates seat `index` (holder = estate.verifiers[index]) with up to 2 backups and 2 monitors. */
export function initSeat(ctx: Ctx, owner: PublicKey, index: number, backups: PublicKey[], monitors: PublicKey[]) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("init_seat", [index, keyArray(backups, 2), keyArray(monitors, 2)], { owner, estate, seat: seatPda(ctx.programId, estate, index) });
}

/** Owner (estate Active) or the seat's holder. */
export function setSeatBackups(ctx: Ctx, authority: PublicKey, estate: PublicKey, index: number, backups: PublicKey[]) {
  return buildIx("set_seat_backups", [index, keyArray(backups, 2)], { authority, estate, seat: seatPda(ctx.programId, estate, index) });
}

/** Owner only. */
export function setSeatMonitors(ctx: Ctx, owner: PublicKey, index: number, monitors: PublicKey[]) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("set_seat_monitors", [index, keyArray(monitors, 2)], { owner, estate, seat: seatPda(ctx.programId, estate, index) });
}

/** Owner: the ordered fallback list (up to 4 wallets). Every open fallback death report is voided. */
export function setFallback(ctx: Ctx, owner: PublicKey, recipients: PublicKey[]) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("set_fallback", [keyArray(recipients, 4)], {
    owner, estate, guard: guardPda(ctx.programId, estate), ...fallbackReportAccounts(ctx, estate),
  });
}

/** Owner (alive): swaps a trusted person directly. The other two seats go too: confirmations by the replaced holder are released. */
export function ownerReplaceSeat(ctx: Ctx, owner: PublicKey, index: number, newHolder: PublicKey) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("owner_replace_seat", [index, newHolder], {
    owner, estate, seat: seatPda(ctx.programId, estate, index),
    next_seat: seatPda(ctx.programId, estate, (index + 1) % 3), last_seat: seatPda(ctx.programId, estate, (index + 2) % 3),
  });
}

/** The signer's own accounts that prove they take part: a seat they monitor, their Beneficiary PDA. */
export interface ActingAs { monitorSeat?: number | null; beneficiary?: boolean }

function actingAccounts(ctx: Ctx, estate: PublicKey, signer: PublicKey, as: ActingAs) {
  return {
    ...(as.monitorSeat !== undefined && as.monitorSeat !== null ? { signer_seat: seatPda(ctx.programId, estate, as.monitorSeat) } : {}),
    ...(as.beneficiary ? { beneficiary_account: beneficiaryPda(ctx.programId, estate, signer) } : {}),
  };
}

/**
 * A trusted person, the owner, this seat's monitor or backup, or an active beneficiary (`as.beneficiary`); never the holder.
 * The ["objection", seat] PDA: a challenge to the report this one replaces is voided.
 */
export function reportSeatDeath(ctx: Ctx, reporter: PublicKey, estate: PublicKey, index: number, certHashHex: string, as: Pick<ActingAs, "beneficiary"> = {}) {
  const seat = seatPda(ctx.programId, estate, index);
  return buildIx("report_seat_death", [index, hash32(certHashHex)], {
    reporter, estate, seat, ...actingAccounts(ctx, estate, reporter, as), objection: objectionPda(ctx.programId, seat),
  });
}

/**
 * Agent: review the death certificate reported for seat `index`. `certHashHex`: the file it read; `holder`: the person
 * it was read for (ReportChanged if either changed since).
 */
export function reviewSeatDeath(estate: PublicKey, agent: PublicKey, index: number, approve: boolean, reportHashHex: string, certHashHex: string, holder: PublicKey) {
  const programId = new PublicKey(getIdl().address);
  return buildIx("review_seat_death", [index, approve, hash32(reportHashHex), hash32(certHashHex), holder], { agent, estate, seat: seatPda(programId, estate, index) });
}

/** `as.beneficiary`: the last holder has neither a monitor nor a second backup, so an active beneficiary confirms. */
export function confirmSeatDeath(ctx: Ctx, confirmer: PublicKey, estate: PublicKey, index: number, as: Pick<ActingAs, "beneficiary"> = {}) {
  return buildIx("confirm_seat_death", [index], {
    confirmer, estate, seat: seatPda(ctx.programId, estate, index), ...actingAccounts(ctx, estate, confirmer, as),
  });
}

/** The holder: "I'm still here". */
export function vetoSeatDeath(ctx: Ctx, holder: PublicKey, estate: PublicKey, index: number) {
  return buildIx("veto_seat_death", [index], { holder, estate, seat: seatPda(ctx.programId, estate, index) });
}

/** Anyone: `caller` is any wallet that signs (so the sponsor can pay the fee; it gains no rights). No remaining accounts. */
export function finalizeSuccession(ctx: Ctx, estate: PublicKey, index: number, caller: PublicKey) {
  const seat = seatPda(ctx.programId, estate, index);
  return buildIx("finalize_succession", [index], { estate, guard: guardPda(ctx.programId, estate), seat, objection: objectionPda(ctx.programId, seat), caller });
}

/**
 * A monitor of `seatIndex` (any seat for Unlock; for Fallback also a beneficiary) objects to `target`.
 * `monitorSeat` = the seat the objector monitors (null for a beneficiary's Fallback objection);
 * `hardshipAsset` = the hardship's asset for Hardship objections.
 */
export function raiseObjection(ctx: Ctx, p: {
  objector: PublicKey; estate: PublicKey; kind: TargetKind; target: PublicKey; seatIndex: number | null; reasonHashHex: string;
  monitorSeat: number | null; beneficiary?: boolean; hardshipAsset?: PublicKey;
}) {
  const needsTarget = p.kind === "Claim" || p.kind === "Sale" || p.kind === "Hardship";
  return buildIx("raise_objection", [targetKind(p.kind), p.target, p.seatIndex ?? NO_SEAT, hash32(p.reasonHashHex)], {
    objector: p.objector, estate: p.estate, guard: guardPda(ctx.programId, p.estate),
    ...(p.monitorSeat !== null ? { seat: seatPda(ctx.programId, p.estate, p.monitorSeat) } : {}),
    ...(p.beneficiary ? { beneficiary_account: beneficiaryPda(ctx.programId, p.estate, p.objector) } : {}),
    ...(needsTarget ? { target_account: p.target } : {}),
    ...(p.hardshipAsset ? { asset: p.hardshipAsset } : {}),
    objection: objectionPda(ctx.programId, p.target),
  });
}

/**
 * A seat holder (not the watched one), or the owner while Active; Fallback objections: a monitor of any seat, so
 * those pass the three seats (one wallet, one vote).
 * `target` = objection.target (passed for Claim, Sale, Hardship and Succession, whichever way the vote goes: a
 * dismissal checks who gains); `hardshipAsset` for Hardship.
 */
export function voteObjection(ctx: Ctx, p: {
  voter: PublicKey; estate: PublicKey; kind: TargetKind; target: PublicKey; uphold: boolean; hardshipAsset?: PublicKey;
}) {
  const needsTarget = p.kind === "Claim" || p.kind === "Sale" || p.kind === "Hardship" || p.kind === "Succession";
  const t = buildIx("vote_objection", [p.uphold], {
    voter: p.voter, estate: p.estate, guard: guardPda(ctx.programId, p.estate), objection: objectionPda(ctx.programId, p.target),
    ...(needsTarget ? { target_account: p.target } : {}),
    ...(p.hardshipAsset ? { asset: p.hardshipAsset } : {}),
  });
  if (p.kind === "Fallback") {
    for (const pubkey of Object.values(seatAccounts(ctx, p.estate))) t.keys.push({ pubkey, isSigner: false, isWritable: false });
  }
  return t;
}

/** The owner only, estate Active (nobody after the unlock): records the asset's photo root (photos stay off-chain). */
export function setAssetMedia(ctx: Ctx, p: { authority: PublicKey; estate: PublicKey; asset: PublicKey; kind: AssetKind; photosRootHex: string; photoCount: number }) {
  return buildIx("set_asset_media", [assetKind(p.kind), hash32(p.photosRootHex), p.photoCount], {
    authority: p.authority, payer: p.authority, estate: p.estate, asset: p.asset, media: mediaPda(ctx.programId, p.asset),
  });
}

/** A participant (see `ActingAs`) other than the recipient reports that slot `index` died, and pays the report's rent. */
export function reportFallbackDeath(ctx: Ctx, reporter: PublicKey, estate: PublicKey, index: number, certHashHex: string, as: ActingAs = {}) {
  return buildIx("report_fallback_death", [index, hash32(certHashHex)], {
    reporter, estate, guard: guardPda(ctx.programId, estate), fallback_report: fallbackReportPda(ctx.programId, estate, index),
    ...actingAccounts(ctx, estate, reporter, as),
  });
}

/**
 * Agent: sets the report's verdict; a rejection closes it to `rentTo` (= report.rent_payer). `certHashHex`: the file it
 * read; `recipient`: the person it was read for (ReportChanged if either changed since).
 */
export function reviewFallbackDeath(estate: PublicKey, agent: PublicKey, index: number, approve: boolean, reportHashHex: string, certHashHex: string, rentTo: PublicKey, recipient: PublicKey) {
  const programId = new PublicKey(getIdl().address);
  return buildIx("review_fallback_death", [index, approve, hash32(reportHashHex), hash32(certHashHex), recipient], {
    agent, estate, guard: guardPda(programId, estate), fallback_report: fallbackReportPda(programId, estate, index), rent_to: rentTo,
  });
}

/** `dead`: a second participant confirms after the wait. Otherwise the reported recipient refutes. Either closes the report to `rentTo`. */
export function resolveFallbackDeath(ctx: Ctx, p: { signer: PublicKey; estate: PublicKey; index: number; dead: boolean; rentTo: PublicKey; as?: ActingAs }) {
  return buildIx("resolve_fallback_death", [p.index, p.dead], {
    signer: p.signer, estate: p.estate, guard: guardPda(ctx.programId, p.estate),
    fallback_report: fallbackReportPda(ctx.programId, p.estate, p.index), rent_to: p.rentTo,
    ...actingAccounts(ctx, p.estate, p.signer, p.as ?? {}),
  });
}

/** Anyone: an Open Fallback objection not upheld within the fallback wait is marked dismissed (lapsed). */
export function lapseObjection(ctx: Ctx, estate: PublicKey, caller: PublicKey) {
  const guard = guardPda(ctx.programId, estate);
  return buildIx("lapse_objection", [], { estate, guard, objection: objectionPda(ctx.programId, guard), caller });
}

/** Anyone (`caller` signs, so the fee can be sponsored): every seat vacant and the owner's death proven. */
export function startFallback(ctx: Ctx, estate: PublicKey, caller: PublicKey) {
  return buildIx("start_fallback", [], { estate, guard: guardPda(ctx.programId, estate), ...seatAccounts(ctx, estate), caller });
}

/**
 * Anyone: after the wait, the whole vault goes to `recipient`, the first fallback recipient not proven dead, at slot
 * `recipientIndex` (whose open death report can hold the payment). The program takes any token account of the mint the
 * recipient owns, or creates their ATA: the ATA is sent. An open challenge to the unlock (["objection", estate]) blocks it.
 */
export function executeFallback(ctx: Ctx, p: { payer: PublicKey; estate: PublicKey; recipient: PublicKey; recipientIndex: number }) {
  const guard = guardPda(ctx.programId, p.estate);
  const vault = vaultAta(ctx.usdtMint, p.estate);
  return buildIx("execute_fallback", [], {
    payer: p.payer, estate: p.estate, guard, ...seatAccounts(ctx, p.estate), objection: objectionPda(ctx.programId, guard),
    recipient: p.recipient, usdt_mint: ctx.usdtMint, vault, recipient_usdt: ata(ctx.usdtMint, p.recipient),
    fallback_report: fallbackReportPda(ctx.programId, p.estate, p.recipientIndex),
    unlock_objection: objectionPda(ctx.programId, p.estate),
  });
}

// ---------- disputes and yearly caps (docs/program-spec.md, added 15 Nov 2026) ----------

/**
 * A beneficiary (`beneficiary: true`, passes their Beneficiary PDA) or a verifier disputes a pending claim
 * (`target` = Claim PDA) or the pending unlock (`target` = the estate). Writes the ["objection", target] PDA.
 */
export function raiseDispute(ctx: Ctx, p: { disputer: PublicKey; estate: PublicKey; kind: "Claim" | "Unlock"; target: PublicKey; reasonHashHex: string; beneficiary: boolean }) {
  return buildIx("raise_dispute", [targetKind(p.kind), p.target, hash32(p.reasonHashHex)], {
    disputer: p.disputer, estate: p.estate, guard: guardPda(ctx.programId, p.estate),
    ...(p.beneficiary ? { beneficiary_account: beneficiaryPda(ctx.programId, p.estate, p.disputer) } : {}),
    ...(p.kind === "Claim" ? { target_account: p.target } : {}),
    objection: objectionPda(ctx.programId, p.target),
  });
}

/** A verifier (not the one who raised it) votes; 2 uphold cancel the action, 2 dismiss let it continue. */
export function resolveDispute(ctx: Ctx, p: { verifier: PublicKey; estate: PublicKey; kind: "Claim" | "Unlock"; target: PublicKey; uphold: boolean }) {
  return buildIx("resolve_dispute", [p.uphold], {
    verifier: p.verifier, estate: p.estate, objection: objectionPda(ctx.programId, p.target),
    ...(p.kind === "Claim" ? { target_account: p.target } : {}),
  });
}

/** Owner (estate Active): set or change a rule's cap per 365-day period. `periodStart` 0 = now / keep the current period. */
export function setYearlyCap(ctx: Ctx, p: { owner: PublicKey; rule: PublicKey; cap: bigint; periodStart: number }) {
  return buildIx("set_yearly_cap", [u64(p.cap), i64(p.periodStart)], {
    owner: p.owner, ...estateAccounts(ctx, p.owner), rule: p.rule, year_cap: yearCapPda(ctx.programId, p.rule),
  });
}

// ---------- continuity (22 Nov 2026) ----------

/** Owner, estate Active: the rule expires now. */
export function endRule(ctx: Ctx, owner: PublicKey, rule: PublicKey) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("end_rule", [], { owner, estate, rule });
}

/** Owner, estate Active: who receives what is left. */
export function setResidual(ctx: Ctx, owner: PublicKey, recipient: PublicKey) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("set_residual", [recipient], { owner, estate, residual: residualPda(ctx.programId, estate) });
}

/**
 * Anyone, estate Unlocked: pays the vault minus what live rules reserve. `rules`: every rule, in id order.
 * `reportIndex`: the Guard's first living fallback slot, else 255 (also without a Guard).
 */
export function sweepResidual(ctx: Ctx, p: { payer: PublicKey; estate: PublicKey; recipient: PublicKey; reportIndex: number; rules: PublicKey[] }) {
  const t = buildIx("sweep_residual", [], {
    payer: p.payer, estate: p.estate, recipient: p.recipient, usdt_mint: ctx.usdtMint,
    residual: residualPda(ctx.programId, p.estate), guard: guardPda(ctx.programId, p.estate),
    vault: vaultAta(ctx.usdtMint, p.estate), recipient_usdt: ata(ctx.usdtMint, p.recipient),
    fallback_report: fallbackReportPda(ctx.programId, p.estate, p.reportIndex),
  });
  for (const pubkey of p.rules) t.keys.push({ pubkey, isSigner: false, isWritable: false });
  return t;
}

/** Owner, estate Active: replaces the agent. What the old agent reviewed (seat and fallback death reports) is set back. */
export function setAgent(ctx: Ctx, owner: PublicKey, agent: PublicKey) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("set_agent", [agent], { owner, estate, ...seatAccounts(ctx, estate), ...fallbackReportAccounts(ctx, estate) });
}

/** Owner, estate Active, asset Held: the title back to the owner, whose token account must exist. Escrow and Asset close to the owner. */
export function releaseAsset(ctx: Ctx, owner: PublicKey, asset: PublicKey, nftMint: PublicKey) {
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("release_asset", [], {
    owner, estate, asset, nft_mint: nftMint, nft_escrow: nftEscrowAta(nftMint, estate), owner_nft: ata(nftMint, owner),
  });
}

/** Owner, estate Active: removes a beneficiary, a payee or both (wallets). Proof of life. */
export function removeMember(ctx: Ctx, owner: PublicKey, p: { beneficiary?: PublicKey; payee?: PublicKey }) {
  if (!p.beneficiary && !p.payee) throw new Error("BadStatus: name a family member or a payee to remove.");
  const { estate } = estateAccounts(ctx, owner);
  return buildIx("remove_member", [], {
    owner, estate, ...seatAccounts(ctx, estate), // the removed beneficiary's pending confirmations are released
    ...(p.beneficiary ? { beneficiary_account: beneficiaryPda(ctx.programId, estate, p.beneficiary) } : {}),
    ...(p.payee ? { payee_account: payeePda(ctx.programId, estate, p.payee) } : {}),
  });
}

/**
 * A trusted person votes to replace the agent's key. The vote that carries it sets back what the old agent reviewed.
 * Remaining accounts: [0] the voter's Beneficiary PDA, always (missing or wrong reads as someone who gains, so it fails
 * closed); [1] after the unlock, the voter's own open claim when they have one (the lone voter who gains waits 2 RT
 * from it while the agent hasn't approved it).
 */
export function voteAgent(ctx: Ctx, estate: PublicKey, verifier: PublicKey, candidate: PublicKey, openClaim?: PublicKey | null) {
  const t = buildIx("vote_agent", [candidate], {
    verifier, estate, agent_vote: agentVotePda(ctx.programId, estate, candidate), ...seatAccounts(ctx, estate), ...fallbackReportAccounts(ctx, estate),
  });
  t.keys.push({ pubkey: beneficiaryPda(ctx.programId, estate, verifier), isSigner: false, isWritable: false });
  if (openClaim) t.keys.push({ pubkey: openClaim, isSigner: false, isWritable: false });
  return t;
}
