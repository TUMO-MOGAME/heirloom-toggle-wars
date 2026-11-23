/**
 * The sale's two signatures (plan §18.4 U4; R12, R19). The trusted person's wallet signs one transaction for one
 * offer and amount, with the agent as fee payer and its signature still empty. The agent signs only after rebuilding
 * that transaction from the chain and finding the same bytes. Pure, so the browser builds and the server checks with
 * the same code.
 */
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { Asset, Base58, Beneficiary, Offer } from "../types";
import { eligibleSeats } from "../death-rules";
import { findInstruction } from "../chain/idl";
import * as ix from "../chain/instructions";

export interface SaleInput {
  estate: Base58;
  agent: Base58;
  asset: Pick<Asset, "address" | "nftMint" | "proceedsTo" | "hardshipBeneficiary">;
  offer: Pick<Offer, "buyer" | "amount">;
  /** Null only when no seat has a holder. */
  coSigner: Base58 | null;
}

/**
 * Who may ask the agent to open or settle a sale: a trusted person, and only when no seat has a holder an active
 * family member, so the asset can't be stuck.
 */
export function mayAskForSale(
  verifiers: readonly (Base58 | null)[],
  beneficiaries: readonly Pick<Beneficiary, "wallet" | "active">[],
  wallet: Base58,
): boolean {
  const seats = eligibleSeats(verifiers);
  return seats.length ? seats.some((i) => verifiers[i] === wallet) : beneficiaries.some((b) => b.active && b.wallet === wallet);
}

type ListedAsset = Pick<Asset, "address" | "status" | "listingEnds" | "floorPrice" | "hardshipFloor" | "hardshipBeneficiary">;

/**
 * Who may ask for a listing: as for the sale, but a family member only for an asset the plan still holds, or whose
 * listing ended with no offer the program would take. Not with such an offer: relisting would put off the lone sale
 * (which waits for the listing to end) for as long as one person kept doing it.
 */
export function mayAskToList(
  verifiers: readonly (Base58 | null)[],
  beneficiaries: readonly Pick<Beneficiary, "wallet" | "active">[],
  wallet: Base58,
  asset: ListedAsset | undefined,
  offers: readonly Pick<Offer, "asset" | "amount">[],
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!mayAskForSale(verifiers, beneficiaries, wallet)) return false;
  if (eligibleSeats(verifiers).length) return true;
  if (!asset) return false;
  if (asset.status === "Held") return true;
  if (asset.status !== "Listed" || asset.listingEnds === null || now < asset.listingEnds) return false;
  const least = asset.hardshipBeneficiary ? asset.hardshipFloor : asset.floorPrice;
  return !offers.some((o) => o.asset === asset.address && o.amount >= least);
}

/** accept_offer exactly as both signers must see it. */
export function saleInstruction(ctx: ix.Ctx, s: SaleInput): TransactionInstruction {
  const pk = (a: Base58) => new PublicKey(a);
  return ix.acceptOffer(ctx, {
    estate: pk(s.estate), agent: pk(s.agent), asset: pk(s.asset.address), nftMint: pk(s.asset.nftMint), buyer: pk(s.offer.buyer),
    recipient: pk(s.asset.hardshipBeneficiary ?? s.asset.proceedsTo),
    hardshipBeneficiary: s.asset.hardshipBeneficiary ? pk(s.asset.hardshipBeneficiary) : null,
    expectedAmount: s.offer.amount, coSigner: s.coSigner ? pk(s.coSigner) : null,
  });
}

/** What the trusted person signs: that one instruction, fee payer = the agent. */
export function saleTransaction(ctx: ix.Ctx, s: SaleInput, recentBlockhash: string): Transaction {
  return new Transaction({ feePayer: new PublicKey(s.agent), recentBlockhash }).add(saleInstruction(ctx, s));
}

/**
 * - bad_sale_tx: not one unsigned-by-the-agent accept_offer paid by the agent, signed by this trusted person;
 * - agent_account: the sale would use the agent's wallet as something other than the agent;
 * - sale_changed: a well-formed sale, but not the one the chain allows now (another offer, amount, recipient…).
 */
export type SaleRefusal = "bad_sale_tx" | "agent_account" | "sale_changed";

export class SaleRefused extends Error {
  constructor(public code: SaleRefusal, message: string) {
    super(message);
    this.name = "SaleRefused";
  }
}

const bad = (why: string) => new SaleRefused("bad_sale_tx", `The sale was not signed in a form the agent accepts: ${why}.`);
const MAX_TX_BYTES = 1232;

/**
 * The transaction the agent may co-sign, or throws. `coSigner` is the caller the route has already checked to be a
 * living trusted person; `expected` is built from the chain, never from what was sent.
 */
export function checkSaleTx(wire: Uint8Array, ctx: ix.Ctx, expected: SaleInput & { coSigner: Base58 }): Transaction {
  const { agent, coSigner } = expected;
  if (wire.length > MAX_TX_BYTES) throw bad("it is too large");
  const slots = wire[0];
  if (!slots || slots > 0x7f || wire.length <= 1 + slots * 64) throw bad("it is not a transaction");
  const message = wire.subarray(1 + slots * 64);
  if (message[0] & 0x80) throw bad("it is a versioned transaction");

  let tx: Transaction;
  let canonical: Uint8Array;
  try {
    tx = Transaction.from(wire);
    canonical = tx.serializeMessage();
  } catch {
    throw bad("it is not a transaction");
  }
  if (!Buffer.from(canonical).equals(Buffer.from(message))) throw bad("its encoding is not canonical");
  if (tx.feePayer?.toBase58() !== agent) throw bad("the agent is not the fee payer");

  if (tx.instructions.length !== 1) throw bad("it holds more than the one sale");
  const [only] = tx.instructions;
  const accept = findInstruction("accept_offer").discriminator;
  if (!only.programId.equals(ctx.programId) || !accept.every((b, i) => only.data[i] === b)) throw bad("it is not a sale");

  if (coSigner === agent) throw new SaleRefused("agent_account", "The agent can't co-sign its own sale.");
  const want = saleTransaction(ctx, expected, tx.recentBlockhash!);
  if (want.instructions[0].keys.filter((k) => k.pubkey.toBase58() === agent).length !== 1) {
    throw new SaleRefused("agent_account", "The agent's wallet can't be the buyer, the recipient or any other account of a sale.");
  }
  // The whole message: every account, flag, argument, signer and the order of all of them.
  if (!Buffer.from(want.serializeMessage()).equals(Buffer.from(message))) {
    throw new SaleRefused("sale_changed", "The offers or the sale changed, or this is not the best offer. Look at the offers again and sign again.");
  }

  const [payer, person, ...others] = tx.signatures;
  if (others.length || payer?.signature || !payer?.publicKey.equals(new PublicKey(agent))) throw bad("the agent's place is not empty");
  if (person?.publicKey.toBase58() !== coSigner || !person.signature) throw bad("the trusted person's signature is missing");
  let verified = false;
  try { verified = tx.verifySignatures(false); } catch { /* refused below */ }
  if (!verified) throw bad("the signature does not match");
  return tx;
}
