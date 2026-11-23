/**
 * Packs instructions, in order, into as few legacy transactions as fit: signing a plan took seven transactions in a
 * row, each with its own blockhash, sponsor check and confirmation polling.
 */
import { Keypair, Transaction, type PublicKey, type TransactionInstruction } from "@solana/web3.js";

/** The packet limit, with room for a compute-budget instruction. */
export const PACK_MAX_BYTES = 1232 - 60;
/** The sponsor allows 200k compute units per instruction by default; creating accounts stays well under it. */
export const PACK_MAX_IXS = 8;

const PLACEHOLDER = Keypair.generate().publicKey;

/** Size with a separate fee payer (the sponsor), the larger of the two ways it can be sent. */
export function txBytes(ixs: TransactionInstruction[], feePayer: PublicKey = PLACEHOLDER): number {
  const tx = new Transaction({ feePayer, blockhash: PLACEHOLDER.toBase58(), lastValidBlockHeight: 0 }).add(...ixs);
  const msg = tx.compileMessage();
  // Not serializeMessage(): it refuses an over-long message instead of measuring it.
  const keys = msg.accountKeys.length;
  let size = 1 + 64 * msg.header.numRequiredSignatures + 3 + 1 + (keys > 127 ? 1 : 0) + 32 * keys + 32 + 1;
  for (const i of msg.compiledInstructions) {
    size += 1 + 1 + i.accountKeyIndexes.length + (i.data.length > 127 ? 2 : 1) + i.data.length;
  }
  return size;
}

export function pack(ixs: TransactionInstruction[]): TransactionInstruction[][] {
  const out: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  for (const next of ixs) {
    if (current.length && (current.length >= PACK_MAX_IXS || txBytes([...current, next]) > PACK_MAX_BYTES)) {
      out.push(current);
      current = [];
    }
    current.push(next);
  }
  if (current.length) out.push(current);
  return out;
}
