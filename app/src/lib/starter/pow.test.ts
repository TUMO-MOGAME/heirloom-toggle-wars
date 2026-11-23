/** Plan §18.3 S2: the starter's proof of work. */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { POW, checkProof, hasZeroBits, powWindow, solveProof, type StarterProof } from "./pow";

const wallet = Keypair.generate().publicKey.toBase58();
const NOW = 1_800_000_000_000;
let pauses = 0;
const proof: StarterProof = await solveProof(wallet, NOW, async () => { pauses++; });

describe("proof of work", () => {
  it("a solved proof checks", () => expect(checkProof(wallet, proof, NOW)).toBe(true));

  it("is bound to the wallet", () => expect(checkProof(Keypair.generate().publicKey.toBase58(), proof, NOW)).toBe(false));

  it("is bound to the time: this window and the ones either side", () => {
    expect(checkProof(wallet, proof, NOW + POW.windowMs)).toBe(true);
    expect(checkProof(wallet, proof, NOW - POW.windowMs)).toBe(true);
    expect(checkProof(wallet, proof, NOW + 2 * POW.windowMs)).toBe(false);
    expect(checkProof(wallet, proof, NOW - 2 * POW.windowMs)).toBe(false);
  });

  it("can't be moved to another window", () => {
    expect(checkProof(wallet, { ...proof, window: proof.window + 1 }, NOW)).toBe(false);
  });

  it.each([
    ["too few", (n: number[]) => n.slice(1)],
    ["too many", (n: number[]) => [...n, 0]],
    ["negative", (n: number[]) => [-1, ...n.slice(1)]],
    ["fractions", (n: number[]) => [n[0] + 0.5, ...n.slice(1)]],
    ["over 32 bits (which would wrap to the same bytes)", (n: number[]) => [n[0] + 2 ** 32, ...n.slice(1)]],
    ["one part's answer used for all", (n: number[]) => n.map(() => n[0])],
  ])("refuses %s", (_what, change) => {
    expect(checkProof(wallet, { ...proof, nonces: change(proof.nonces) }, NOW)).toBe(false);
  });

  it("counts leading zero bits", () => {
    expect(hasZeroBits(new Uint8Array([0, 1]), 15)).toBe(true);
    expect(hasZeroBits(new Uint8Array([0, 2]), 15)).toBe(false);
    expect(hasZeroBits(new Uint8Array([1, 0]), 15)).toBe(false);
    expect(hasZeroBits(new Uint8Array([0, 255]), 8)).toBe(true);
  });

  it("gives the screen a turn while it works", () => {
    expect(pauses).toBeGreaterThanOrEqual(1);
    expect(proof.window).toBe(powWindow(NOW));
  });

  it("is about 200,000 hashes: a second or two on a phone", () => {
    expect(POW.parts * 2 ** POW.bits).toBe(196_608);
  });
});
