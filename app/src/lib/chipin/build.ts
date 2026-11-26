/**
 * Builds a chip-in: one SPL Token transfer_checked from the payer's USD₮ account into the estate's vault (the
 * associated token account of the estate PDA), with the estate's tag and a per-request reference as read-only,
 * non-signer keys. The program keeps no separate deposit total, so this is the same as `deposit` for the vault, and
 * the program is not involved. Unsigned; fee payer = the wallet that asked (Solana Pay: signatures empty, feePayer
 * = account, recentBlockhash = latest). Heirloom's fee sponsor is not used: a stranger's wallet pays its own fee.
 *
 * Every check the existing send path makes (lib/service/chain.ts reviewSend) is made here before anything is built:
 * the estate is a Heirloom estate, Active, configured with this app's USD₮ mint, and that mint exists with 6
 * decimals; the vault account exists, holds that mint and belongs to the estate; the amount passes the strict parser
 * and the limit; the payer is a valid address, not the estate or the vault, holds enough USD₮ and some SOL.
 */
import { PublicKey, Transaction, type AccountInfo, type Connection, type ParsedAccountData } from "@solana/web3.js";
import { createTransferCheckedInstruction } from "@solana/spl-token";
import { ata, vaultAta } from "../chain/pda";
import { ownAccount } from "../chain/reads";
import { decodeEstate } from "../chain/decoders";
import { bytesToBase64 } from "../chain/tx";
import { formatUsdtExact } from "../format";
import { CHIP_IN_LABEL, checkChipInAmount, chipInTag, isAddress } from "./link";
import { ChipInError } from "./errors";

export { ChipInError, CHIP_IN_ERRORS, type ChipInCode } from "./errors";

export type ChipInConn = Pick<Connection, "getAccountInfo" | "getParsedAccountInfo" | "getBalance" | "getLatestBlockhash">;

/** A network fee for one signature, with room to spare. */
const MIN_FEE_LAMPORTS = 10_000;

type Parsed = { type?: string; info?: Record<string, unknown> };
const parsedOf = (info: AccountInfo<Buffer | ParsedAccountData> | null): Parsed | null =>
  info && !Buffer.isBuffer(info.data) && typeof info.data === "object" && "parsed" in info.data ? (info.data.parsed as Parsed) : null;

export interface ChipInTarget { estate: PublicKey; mint: PublicKey; vault: PublicKey }

/**
 * The estate's vault, after every check on the estate and the token. `expectMint`: this app's configured USD₮ mint.
 * Throws ChipInError. Used by GET (to show the action as available or not) and by POST.
 */
export async function chipInTarget(conn: ChipInConn, estate: string, expectMint: string): Promise<ChipInTarget> {
  if (!isAddress(estate)) throw new ChipInError("bad_estate", 404);
  const estateKey = new PublicKey(estate);
  const raw = ownAccount("Estate", await conn.getAccountInfo(estateKey, "confirmed"));
  if (!raw) throw new ChipInError("bad_estate", 404);
  const e = decodeEstate(estate, raw, 0n);
  if (e.status !== "Active") throw new ChipInError("not_active", 409);
  if (!expectMint || e.usdtMint !== expectMint) throw new ChipInError("token_unverified", 409);
  const mint = new PublicKey(e.usdtMint);
  const mintInfo = parsedOf((await conn.getParsedAccountInfo(mint, "confirmed")).value);
  if (mintInfo?.type !== "mint" || mintInfo.info?.decimals !== 6) throw new ChipInError("token_unverified", 409);
  const vault = vaultAta(mint, estateKey);
  const v = parsedOf((await conn.getParsedAccountInfo(vault, "confirmed")).value);
  if (v?.type !== "account" || v.info?.mint !== mint.toBase58() || v.info?.owner !== estate || v.info?.state === "frozen") {
    throw new ChipInError("no_vault", 409);
  }
  return { estate: estateKey, mint, vault };
}

export interface BuiltChipIn {
  /** Base64 of an unsigned legacy transaction (fee payer = account). */
  transaction: string;
  /** For the wallet to show: what this does, with no names. */
  message: string;
  amount: bigint;
  reference: string;
  tag: string;
}

export interface ChipInRequest {
  estate: string;
  account: unknown;
  amount: string | null;
  /** From the QR code; a fresh one is made when absent. */
  reference?: string | null;
  expectMint: string;
  cluster: string;
  /** Makes a reference when none was given (tests pass a fixed one). */
  newReference: () => string;
}

export async function buildChipIn(conn: ChipInConn, req: ChipInRequest): Promise<BuiltChipIn> {
  const amount = checkChipInAmount(req.amount);
  if (!amount.ok) throw new ChipInError(amount.code);
  if (!isAddress(req.account)) throw new ChipInError("bad_account");
  if (req.reference !== undefined && req.reference !== null && !isAddress(req.reference)) throw new ChipInError("bad_reference");
  const target = await chipInTarget(conn, req.estate, req.expectMint);
  const payer = new PublicKey(req.account);
  if (payer.equals(target.estate) || payer.equals(target.vault)) throw new ChipInError("bad_account");

  const source = ata(target.mint, payer);
  const src = parsedOf((await conn.getParsedAccountInfo(source, "confirmed")).value);
  if (src?.type !== "account" || src.info?.mint !== target.mint.toBase58() || src.info?.owner !== payer.toBase58()) throw new ChipInError("no_usdt");
  if (src.info?.state === "frozen") throw new ChipInError("no_usdt");
  const held = BigInt(String((src.info?.tokenAmount as { amount?: string } | undefined)?.amount ?? "0"));
  if (held < amount.base) throw new ChipInError(held === 0n ? "no_usdt" : "not_enough_usdt");
  if ((await conn.getBalance(payer, "confirmed")) < MIN_FEE_LAMPORTS) throw new ChipInError("no_sol");

  const reference = req.reference ?? req.newReference();
  const tag = chipInTag(req.estate);
  const ix = createTransferCheckedInstruction(source, target.mint, target.vault, payer, amount.base, 6);
  // Solana Pay references: read-only, non-signer keys on the transfer itself. The token program ignores them (the
  // owner is a wallet, not a multisig), and getSignaturesForAddress finds the transaction by either.
  ix.keys.push({ pubkey: new PublicKey(tag), isSigner: false, isWritable: false }, { pubkey: new PublicKey(reference), isSigner: false, isWritable: false });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(ix);
  const transaction = bytesToBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const test = req.cluster === "mainnet-beta" ? "" : " Test USD₮ on Solana devnet.";
  return { transaction, message: `Adds ${formatUsdtExact(amount.base)} to a ${CHIP_IN_LABEL}.${test}`, amount: amount.base, reference, tag };
}
