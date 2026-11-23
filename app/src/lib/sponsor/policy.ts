/**
 * Fee-sponsorship policy: decides whether Heirloom's sponsor wallet (the agent's Tether WDK wallet) may co-sign
 * a user's transaction as its fee payer, so families never need SOL for network fees.
 *
 * Pure and synchronous (no RPC, no keys), so every rule is unit-tested (policy.test.ts). The route
 * (/api/sponsor) adds what needs the network: simulation, sponsor balance, rate limits, then co-signs.
 *
 * Allowed (everything else is rejected):
 *  - Legacy transactions only, ≤ 1232 bytes, fee payer (account #0) = the sponsor, sponsor's signature slot empty,
 *    every other required signature present and valid, at most `maxSigners` signers.
 *  - Compute Budget: SetComputeUnitLimit (≤ maxComputeUnits) and SetComputeUnitPrice (≤ maxMicroLamports), once each.
 *  - SPL Token (classic program): TransferChecked of the configured USD₮ mint with its decimals, amount > 0,
 *    a single (non-multisig) authority that signed and is not the sponsor.
 *  - Associated Token Account program: Create / CreateIdempotent of the USD₮ ATA (correct derivation) for an owner
 *    that is not the sponsor. The sponsor may be the rent payer only when `sponsorPaysRent` and the same tx sends
 *    USD₮ into that ATA; at most `maxAtaCreates` per tx.
 *  - Heirloom program: instructions whose 8-byte discriminator is on the allow-list. The permissionless ones
 *    (finalize_unlock, finalize_succession, start_fallback, lapse_objection) take any wallet as a signing `caller`,
 *    so they too have a user signature to check and rate-limit; the sponsor can never be that caller.
 *  - So the sponsor is never a reporter (who pays a report's rent), `rent_to`, a `payer` other than approve_claim's
 *    and approve_hardship's,
 *    a `co_signer` or a close destination, as a named or a remaining account.
 *  - Rent for one account per transaction: one token account or one approval stamp.
 *  - The sponsor's key may appear in no instruction at all, except as the rent payer of an allowed ATA creation, or as
 *    the `payer` of approve_claim or approve_hardship (rent for the small ApprovalStamp of the claim or the hardship,
 *    once per tx, only when `sponsorPaysRent`):
 *    so it is never a source, authority, owner, or account any program can debit beyond that rent.
 *  - Estimated fee (5000 lamports × signatures + priority fee) ≤ maxFeeLamports.
 *  - Every signer is one the transaction needs (plan §18.9 H3): a token transfer's authority, a Heirloom instruction's
 *    signer by the IDL (`heirloomAccounts`), or a user-paid ATA's payer when it is one of those. A throwaway extra
 *    signer is refused, so limits keyed on the signers are keyed on the real actors. A permissionless instruction (any
 *    caller) also names its estate in `cranks`, so the server can limit cranking one estate however many callers.
 */
import { ComputeBudgetProgram, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const LAMPORTS_PER_SIGNATURE = 5000;
export const TOKEN_ACCOUNT_RENT = 2_039_280; // rent-exempt minimum for a 165-byte SPL token account
export const MAX_TX_BYTES = 1232;
/** Rent-exempt minimum for an ApprovalStamp (8 + 32 + 1 + 32 + 8 + 1 = 82 bytes). */
export const APPROVAL_STAMP_RENT = (82 + 128) * 6960;
/** Heirloom instructions whose named account the sponsor may fill as the rent payer (the approval stamp of a claim or a hardship). */
export const SPONSOR_RENT_PAYER_ACCOUNTS: Record<string, string> = { approve_claim: "payer", approve_hardship: "payer" };

/** User-initiated Heirloom instructions the sponsor will pay fees for. Agent-only ones (review_*, list_asset, accept_offer) are excluded. */
export const SPONSORED_HEIRLOOM_IXS = [
  "create_estate", "set_will", "add_beneficiary", "add_payee", "add_rule", "add_rule_v2", "deposit", "withdraw", "heartbeat", "veto_death",
  "register_asset", "owner_approve_claim", "submit_death_claim", "submit_claim", "submit_hardship", "attest_death",
  "approve_claim", "approve_hardship", "finalize_unlock", "execute_claim", "execute_scheduled", "place_offer", "withdraw_offer",
  // Guardians (docs/guardians-spec.md §2.2). The agent's review_seat_death / review_fallback_death are not sponsored.
  "init_guard", "init_seat", "set_seat_backups", "set_seat_monitors", "set_fallback", "owner_replace_seat",
  "report_seat_death", "confirm_seat_death", "veto_seat_death", "finalize_succession",
  "raise_objection", "vote_objection", "set_asset_media", "report_fallback_death", "start_fallback", "execute_fallback",
  "lapse_objection",
  // Disputes and yearly caps (15 Nov 2026).
  "raise_dispute", "resolve_dispute", "set_yearly_cap",
  // Continuity (22 Nov 2026): the signer pays any rent.
  "end_rule", "set_residual", "sweep_residual", "set_agent", "vote_agent",
  // Second security review (22 Nov 2026). Rent comes back to whoever paid it, never to or from the sponsor.
  "resolve_fallback_death", "release_asset", "remove_member",
] as const;

export interface SponsorPolicy {
  sponsor: PublicKey;
  usdtMint: PublicKey;
  usdtDecimals: number;
  heirloomProgram: PublicKey;
  /** name → 8-byte Anchor discriminator, for the instructions in SPONSORED_HEIRLOOM_IXS present in the IDL. */
  heirloomDiscriminators: Record<string, number[]>;
  maxFeeLamports: number;
  maxSigners: number;
  maxComputeUnits: number;
  maxMicroLamports: number;
  sponsorPaysRent: boolean;
  maxAtaCreates: number;
  /** ix name → account index where the sponsor may appear as rent payer (from SPONSOR_RENT_PAYER_ACCOUNTS + the IDL). */
  heirloomRentPayerSlots?: Record<string, number>;
  /**
   * ix name → the IDL's signer account indexes, and the estate account's index. Without it (unit tests) a Heirloom
   * instruction's signer flags stand in for the IDL's.
   */
  heirloomAccounts?: Record<string, { signers: number[]; estate: number }>;
}

/** Heirloom instructions any wallet may sign as the caller: the estate is the actor that matters. */
export const PERMISSIONLESS_IXS: readonly string[] = [
  "finalize_unlock", "finalize_succession", "start_fallback", "lapse_objection",
  "execute_claim", "execute_scheduled", "execute_fallback", "sweep_residual",
];

export const DEFAULT_LIMITS = {
  maxFeeLamports: 20_000,
  maxSigners: 3,
  maxComputeUnits: 400_000,
  maxMicroLamports: 50_000,
  maxAtaCreates: 1,
} as const;

export type RejectCode =
  | "malformed" | "too_large" | "versioned" | "wrong_fee_payer" | "sponsor_signed" | "missing_signature" | "bad_signature"
  | "too_many_signers" | "unknown_program" | "sponsor_in_instruction" | "bad_compute_budget" | "bad_token_ix" | "wrong_mint"
  | "bad_ata_ix" | "rent_not_allowed" | "bad_heirloom_ix" | "fee_too_high" | "empty" | "unneeded_signer";

export class SponsorRejection extends Error {
  constructor(public code: RejectCode, message: string) { super(message); this.name = "SponsorRejection"; }
}

export interface SponsorDecision {
  tx: Transaction;
  /** Signers other than the sponsor: every one is an actor the transaction needs, and every one is charged. */
  signers: string[];
  /** Estates of the permissionless instructions in it (finalize, execute, sweep...), for a limit per estate. */
  cranks: string[];
  feeLamports: number;
  /** Lamports the sponsor will spend on rent for new token accounts. */
  rentLamports: number;
  summary: string[];
}

const reject = (code: RejectCode, msg: string): never => { throw new SponsorRejection(code, msg); };

const u32 = (d: Uint8Array, at: number) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16)) + d[at + 3] * 2 ** 24;
function u64(d: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function ataOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Validates the (partially signed) wire bytes against the policy. Throws SponsorRejection with a code. */
export function validateSponsoredTx(wire: Uint8Array, p: SponsorPolicy): SponsorDecision {
  if (wire.length > MAX_TX_BYTES) reject("too_large", "Transaction is larger than the Solana packet limit.");
  // Peek at the message's first byte: the high bit marks a versioned (v0) message, which we do not sponsor.
  const sigCount = wire[0];
  if (wire.length < 1 || sigCount === 0 || sigCount > 0x7f) reject("malformed", "Malformed transaction.");
  const msgFirst = wire[1 + sigCount * 64];
  if (msgFirst === undefined) reject("malformed", "Malformed transaction.");
  if (msgFirst & 0x80) reject("versioned", "Only legacy transactions can be sponsored.");

  let tx: Transaction;
  try { tx = Transaction.from(wire); } catch { return reject("malformed", "Malformed transaction."); }
  // web3.js must re-serialize exactly the bytes that were signed, or signature checks would be meaningless.
  if (!bytesEqual(tx.serializeMessage(), wire.subarray(1 + sigCount * 64))) reject("malformed", "Non-canonical transaction encoding.");
  if (!tx.feePayer?.equals(p.sponsor)) reject("wrong_fee_payer", "The fee payer must be the Heirloom sponsor.");
  if (tx.signatures.length > p.maxSigners) reject("too_many_signers", `At most ${p.maxSigners} signers can be sponsored.`);
  if (tx.signatures.length < 2) reject("missing_signature", "The sender's signature is missing.");

  const signers: string[] = [];
  for (const [i, s] of tx.signatures.entries()) {
    if (i === 0) {
      if (!s.publicKey.equals(p.sponsor)) reject("wrong_fee_payer", "The fee payer must be the Heirloom sponsor.");
      if (s.signature) reject("sponsor_signed", "The sponsor's signature slot must be empty.");
      continue;
    }
    if (s.publicKey.equals(p.sponsor)) reject("sponsor_in_instruction", "The sponsor may only be the fee payer.");
    if (!s.signature) reject("missing_signature", `Missing signature from ${s.publicKey.toBase58()}.`);
    signers.push(s.publicKey.toBase58());
  }
  // Verifies every present signature (the sponsor's empty slot is skipped).
  let sigsOk = false;
  try { sigsOk = tx.verifySignatures(false); } catch { sigsOk = false; }
  if (!sigsOk) reject("bad_signature", "A signature does not match the transaction.");

  const ixs = tx.instructions;
  if (!ixs.some((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))) reject("empty", "Nothing to sponsor.");

  const allowedDiscs = Object.entries(p.heirloomDiscriminators);
  const transfersInto = new Set<string>();
  /** Signers some instruction needs; and user-paid ATA payers, which must be among them. */
  const needed = new Set<string>();
  const ataPayers: string[] = [];
  const cranks = new Set<string>();
  const ataCreates: { ata: PublicKey; sponsorPays: boolean }[] = [];
  let stampRents = 0;
  let cuLimit: number | null = null;
  let cuPrice: bigint | null = null;
  const summary: string[] = [];

  const sponsorIn = (ix: TransactionInstruction, exceptIndex?: number) =>
    ix.keys.some((k, i) => i !== exceptIndex && k.pubkey.equals(p.sponsor));

  for (const ix of ixs) {
    const d = ix.data;
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (ix.keys.length) reject("bad_compute_budget", "Compute budget instructions take no accounts.");
      if (d[0] === 2 && d.length === 5) {
        if (cuLimit !== null) reject("bad_compute_budget", "Duplicate compute unit limit.");
        cuLimit = u32(d, 1);
        if (cuLimit > p.maxComputeUnits) reject("bad_compute_budget", "Compute unit limit too high.");
      } else if (d[0] === 3 && d.length === 9) {
        if (cuPrice !== null) reject("bad_compute_budget", "Duplicate compute unit price.");
        cuPrice = u64(d, 1);
        if (cuPrice > BigInt(p.maxMicroLamports)) reject("bad_compute_budget", "Priority fee too high.");
      } else {
        reject("bad_compute_budget", "Only compute unit limit and price instructions are allowed.");
      }
      continue;
    }

    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      // TransferChecked: [12, amount u64, decimals u8]; accounts [source, mint, destination, authority]
      if (d[0] !== 12 || d.length !== 10) reject("bad_token_ix", "Only USD₮ transfers (TransferChecked) are allowed.");
      if (ix.keys.length !== 4) reject("bad_token_ix", "Multisig token authorities are not supported.");
      if (sponsorIn(ix)) reject("sponsor_in_instruction", "The sponsor cannot be part of a token transfer.");
      const [source, mint, dest, authority] = ix.keys;
      if (!mint.pubkey.equals(p.usdtMint)) reject("wrong_mint", "Only the configured USD₮ mint can be sent with sponsored fees.");
      if (d[9] !== p.usdtDecimals) reject("wrong_mint", "Wrong decimals for USD₮.");
      const amount = u64(d, 1);
      if (amount <= 0n) reject("bad_token_ix", "Amount must be above zero.");
      if (!authority.isSigner || !signers.includes(authority.pubkey.toBase58())) reject("bad_token_ix", "The token owner must sign the transfer.");
      if (source.pubkey.equals(dest.pubkey)) reject("bad_token_ix", "Source and destination are the same.");
      transfersInto.add(dest.pubkey.toBase58());
      needed.add(authority.pubkey.toBase58());
      summary.push(`USD₮ transfer ${amount} → ${dest.pubkey.toBase58()}`);
      continue;
    }

    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // Create (empty data or [0]) / CreateIdempotent ([1]); accounts [payer, ata, owner, mint, system, token]
      if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) reject("bad_ata_ix", "Only token account creation is allowed.");
      if (ix.keys.length !== 6) reject("bad_ata_ix", "Unexpected accounts for token account creation.");
      const [payer, ataKey, owner, mint, system, token] = ix.keys;
      if (!mint.pubkey.equals(p.usdtMint)) reject("wrong_mint", "Only USD₮ token accounts can be created.");
      if (!token.pubkey.equals(TOKEN_PROGRAM_ID)) reject("bad_ata_ix", "Wrong token program.");
      if (!system.pubkey.equals(new PublicKey("11111111111111111111111111111111"))) reject("bad_ata_ix", "Wrong system program.");
      if (owner.pubkey.equals(p.sponsor)) reject("sponsor_in_instruction", "The sponsor cannot own accounts created here.");
      if (sponsorIn(ix, 0)) reject("sponsor_in_instruction", "The sponsor may only be the rent payer.");
      if (!ataKey.pubkey.equals(ataOf(owner.pubkey, p.usdtMint))) reject("bad_ata_ix", "Token account address does not match its owner.");
      const sponsorPays = payer.pubkey.equals(p.sponsor);
      if (!sponsorPays && !signers.includes(payer.pubkey.toBase58())) reject("bad_ata_ix", "The rent payer must sign.");
      ataCreates.push({ ata: ataKey.pubkey, sponsorPays });
      if (!sponsorPays) ataPayers.push(payer.pubkey.toBase58());
      if (ataCreates.length > p.maxAtaCreates) reject("bad_ata_ix", "Too many token accounts created in one transaction.");
      summary.push(`create USD₮ account for ${owner.pubkey.toBase58()}${sponsorPays ? " (rent sponsored)" : ""}`);
      continue;
    }

    if (ix.programId.equals(p.heirloomProgram)) {
      if (d.length < 8) reject("bad_heirloom_ix", "Not a Heirloom instruction.");
      const hit = allowedDiscs.find(([, disc]) => disc.every((x, i) => d[i] === x));
      if (!hit) reject("bad_heirloom_ix", "This Heirloom instruction is not eligible for sponsored fees.");
      const slot = p.heirloomRentPayerSlots?.[hit![0]];
      if (sponsorIn(ix, slot)) reject("sponsor_in_instruction", "The sponsor cannot be an account of a Heirloom instruction.");
      const shape = p.heirloomAccounts?.[hit![0]];
      const signerSlots = shape ? shape.signers : ix.keys.flatMap((k, i) => (k.isSigner ? [i] : []));
      for (const i of signerSlots) if (ix.keys[i] && i !== slot) needed.add(ix.keys[i].pubkey.toBase58());
      if (PERMISSIONLESS_IXS.includes(hit![0])) {
        const estate = ix.keys[shape?.estate ?? 0];
        if (estate) cranks.add(estate.pubkey.toBase58());
      }
      if (slot !== undefined && ix.keys[slot]?.pubkey.equals(p.sponsor)) {
        if (!p.sponsorPaysRent) reject("rent_not_allowed", "The sponsor does not pay rent.");
        if (++stampRents > 1) reject("rent_not_allowed", "Only one sponsored approval per transaction.");
        summary.push(`heirloom ${hit![0]} (stamp rent sponsored)`);
        continue;
      }
      summary.push(`heirloom ${hit![0]}`);
      continue;
    }

    reject("unknown_program", `Program ${ix.programId.toBase58()} is not eligible for sponsored fees.`);
  }

  for (const payer of ataPayers) {
    if (!needed.has(payer)) reject("unneeded_signer", "A new token account's rent payer must be someone the transaction needs.");
  }
  for (const s of signers) {
    if (!needed.has(s)) reject("unneeded_signer", `${s} signs, but nothing in the transaction needs that signature.`);
  }

  if (stampRents + ataCreates.filter((c) => c.sponsorPays).length > 1) reject("rent_not_allowed", "The sponsor pays rent for one new account per transaction.");
  let rentLamports = stampRents * APPROVAL_STAMP_RENT;
  for (const c of ataCreates) {
    if (!c.sponsorPays) continue;
    if (!p.sponsorPaysRent) reject("rent_not_allowed", "The sponsor does not pay for new token accounts.");
    if (!transfersInto.has(c.ata.toBase58())) reject("rent_not_allowed", "Sponsored token accounts must receive USD₮ in the same transaction.");
    rentLamports += TOKEN_ACCOUNT_RENT;
  }

  const nonBudget = ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)).length;
  const units = cuLimit ?? Math.min(1_400_000, 200_000 * nonBudget);
  const priority = cuPrice ? Number((cuPrice * BigInt(units) + 999_999n) / 1_000_000n) : 0;
  const feeLamports = LAMPORTS_PER_SIGNATURE * tx.signatures.length + priority;
  if (feeLamports > p.maxFeeLamports) reject("fee_too_high", `Fee ${feeLamports} lamports is above the sponsor cap (${p.maxFeeLamports}).`);

  return { tx, signers, cranks: [...cranks], feeLamports, rentLamports, summary };
}
