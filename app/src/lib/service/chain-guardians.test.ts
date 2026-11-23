/** Chain guardians service: owner_replace_seat is built from the bundled IDL with the right accounts and arguments. */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { findInstruction, getCoder, getIdl } from "../chain/idl";
import { estatePda, seatPda } from "../chain/pda";
import type { EstateMeta } from "../db";

const programId = new PublicKey(getIdl().address);
const usdtMint = Keypair.generate().publicKey;
vi.mock("../chain/client", () => ({ chainCtx: () => ({ programId, usdtMint }) }));

const { createChainGuardians } = await import("./chain-guardians");

const owner = Keypair.generate().publicKey;
const estate = estatePda(programId, owner).toBase58();
const newHolder = Keypair.generate().publicKey.toBase58();

function setup(opts: { notOwner?: boolean } = {}) {
  const sent: TransactionInstruction[][] = [];
  const saved: EstateMeta[] = [];
  const meta: EstateMeta = {
    estate, ownerWallet: owner.toBase58(), ownerName: "Thabo", verifierNames: ["Ndlovu", "Pillay", "Bongani"], assetTitles: {}, buyerNames: {},
  };
  const svc = createChainGuardians({
    send: async (ixs) => { sent.push(typeof ixs === "function" ? ixs(owner) : ixs); return { signature: "sig", explorerUrl: "" } as never; },
    review: async () => { throw new Error("not used"); },
    getMeta: async () => meta,
    saveMeta: async (m) => { saved.push(m); },
    requireOwnerOf: () => { if (opts.notOwner) throw new Error("NotOwner: switch to the owner's wallet."); return owner; },
    getEstate: async () => ({}),
  });
  return { svc, sent, saved };
}

describe("chain ownerReplaceSeat", () => {
  it("sends owner_replace_seat(index, new_holder) with owner, estate, the seat and the other two seats in IDL order", async () => {
    const { svc, sent } = setup();
    await svc.ownerReplaceSeat(estate, 2, { wallet: ` ${newHolder} `, name: "Mr. Sizwe Dlamini" });
    expect(sent).toHaveLength(1);
    const [t] = sent[0];
    expect(t.programId.equals(programId)).toBe(true);
    const def = findInstruction("owner_replace_seat");
    expect(def.accounts.map((a) => a.name)).toEqual(["owner", "estate", "seat", "next_seat", "last_seat"]);
    const seat = (i: number) => seatPda(programId, new PublicKey(estate), i).toBase58();
    expect(t.keys.map((k) => k.pubkey.toBase58())).toEqual([owner.toBase58(), estate, seat(2), seat(0), seat(1)]);
    expect(t.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[true, false], [false, true], [false, true], [false, true], [false, true]]);
    const decoded = getCoder().instruction.decode(Buffer.from(t.data)) as unknown as { name: string; data: { index: number; new_holder: PublicKey } };
    expect(decoded.name).toBe(def.name);
    expect(decoded.data.index).toBe(2);
    expect(decoded.data.new_holder.toBase58()).toBe(newHolder);
  });

  it("keeps the new person's name off-chain in the estate meta", async () => {
    const { svc, saved } = setup();
    await svc.ownerReplaceSeat(estate, 0, { wallet: newHolder, name: "  Mr. Sizwe Dlamini " });
    expect(saved.at(-1)?.buyerNames[newHolder]).toBe("Mr. Sizwe Dlamini");
  });

  it("refuses a malformed wallet before anything is sent", async () => {
    const { svc, sent } = setup();
    await expect(svc.ownerReplaceSeat(estate, 1, { wallet: "not-a-wallet", name: "X" })).rejects.toThrow(/^InvalidAddress/);
    expect(sent).toHaveLength(0);
  });

  it("only the owner's wallet can send it", async () => {
    const { svc, sent } = setup({ notOwner: true });
    await expect(svc.ownerReplaceSeat(estate, 1, { wallet: newHolder, name: "X" })).rejects.toThrow(/^NotOwner/);
    expect(sent).toHaveLength(0);
  });
});
