import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ata, assetPda, beneficiaryPda, claimPda, estatePda, hardshipPda, offerPda, payeePda, rulePda, vaultAta,
  guardPda, mediaPda, objectionPda, seatPda, stampPda,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "./pda";

const program = new PublicKey("b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY");
const owner = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const ref = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

describe("PDA seeds (docs/program-spec.md)", () => {
  const estate = estatePda(program, owner);

  it("estate = [estate, owner]", () => {
    expect(estate.equals(ref([Buffer.from("estate"), owner.toBuffer()]))).toBe(true);
    expect(estatePda(program, owner.toBase58()).equals(estate)).toBe(true);
  });

  it("beneficiary / payee = [tag, estate, wallet]", () => {
    expect(beneficiaryPda(program, estate, other).equals(ref([Buffer.from("beneficiary"), estate.toBuffer(), other.toBuffer()]))).toBe(true);
    expect(payeePda(program, estate, other).equals(ref([Buffer.from("payee"), estate.toBuffer(), other.toBuffer()]))).toBe(true);
  });

  it("rule uses u16 LE id; claim uses u32 LE id", () => {
    const le16 = Buffer.alloc(2); le16.writeUInt16LE(258);
    const rule = rulePda(program, estate, 258);
    expect(rule.equals(ref([Buffer.from("rule"), estate.toBuffer(), le16]))).toBe(true);
    const le32 = Buffer.alloc(4); le32.writeUInt32LE(70000);
    expect(claimPda(program, rule, 70000).equals(ref([Buffer.from("claim"), rule.toBuffer(), le32]))).toBe(true);
  });

  it("asset / offer / hardship", () => {
    const mint = Keypair.generate().publicKey;
    const asset = assetPda(program, estate, mint);
    expect(asset.equals(ref([Buffer.from("asset"), estate.toBuffer(), mint.toBuffer()]))).toBe(true);
    expect(offerPda(program, asset, other).equals(ref([Buffer.from("offer"), asset.toBuffer(), other.toBuffer()]))).toBe(true);
    expect(hardshipPda(program, asset, other).equals(ref([Buffer.from("hardship"), asset.toBuffer(), other.toBuffer()]))).toBe(true);
  });

  it("rejects out-of-range ids", () => {
    expect(() => rulePda(program, estate, 65536)).toThrow(RangeError);
    expect(() => claimPda(program, estate, -1)).toThrow(RangeError);
  });

  it("vault is the ATA of the estate PDA (off-curve owner)", () => {
    const mint = Keypair.generate().publicKey;
    const expected = PublicKey.findProgramAddressSync([estate.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
    expect(vaultAta(mint, estate).equals(expected)).toBe(true);
    expect(ata(mint, estate).equals(expected)).toBe(true);
  });
});

describe("PDA seeds (docs/guardians-spec.md)", () => {
  const estate = estatePda(program, owner);
  it("seat = [seat, estate, u8 index]; guard = [guard, estate]", () => {
    expect(seatPda(program, estate, 2).equals(ref([Buffer.from("seat"), estate.toBuffer(), Buffer.from([2])]))).toBe(true);
    expect(seatPda(program, estate, 0).equals(seatPda(program, estate, 1))).toBe(false);
    expect(guardPda(program, estate).equals(ref([Buffer.from("guard"), estate.toBuffer()]))).toBe(true);
    expect(() => seatPda(program, estate, 256)).toThrow(RangeError);
  });
  it("stamp / objection / media = [tag, target]", () => {
    expect(stampPda(program, other).equals(ref([Buffer.from("stamp"), other.toBuffer()]))).toBe(true);
    expect(objectionPda(program, other).equals(ref([Buffer.from("objection"), other.toBuffer()]))).toBe(true);
    expect(mediaPda(program, other).equals(ref([Buffer.from("media"), other.toBuffer()]))).toBe(true);
  });
});
