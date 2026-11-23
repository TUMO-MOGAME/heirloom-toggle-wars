import { describe, expect, it } from "vitest";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PACK_MAX_BYTES, pack, txBytes } from "./pack";

const programId = Keypair.generate().publicKey;
const signer = Keypair.generate().publicKey;
const ix = (n: number) => new TransactionInstruction({
  programId, data: Buffer.alloc(40, n),
  keys: [{ pubkey: signer, isSigner: true, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }],
});

describe("pack", () => {
  it("measures like web3.js", () => {
    const feePayer = Keypair.generate().publicKey;
    const ixs = [ix(1), ix(2), ix(3)];
    const tx = new Transaction({ feePayer, blockhash: feePayer.toBase58(), lastValidBlockHeight: 0 }).add(...ixs);
    const real = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    expect(txBytes(ixs, feePayer)).toBeGreaterThanOrEqual(real);
    expect(txBytes(ixs, feePayer) - real).toBeLessThan(8);
  });

  it("keeps the order and never overfills", () => {
    const ixs = Array.from({ length: 30 }, (_, i) => ix(i));
    const groups = pack(ixs);
    expect(groups.flat()).toEqual(ixs);
    for (const g of groups) expect(txBytes(g)).toBeLessThanOrEqual(PACK_MAX_BYTES);
    expect(groups.length).toBeLessThan(8);
  });
});
