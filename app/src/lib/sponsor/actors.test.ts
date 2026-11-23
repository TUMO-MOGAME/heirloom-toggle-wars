/**
 * Plan §18.9 H3: the sponsor's limits were keyed on the first signer, which a throwaway key controls (146 co-signs from
 * one wallet emptied the day without one broadcast). Now every signer must be needed and is charged, a permissionless
 * call is also charged to its estate, and each network address has a day's cap. Real transactions from the app's own
 * builders, real signatures; the RPC and the agent's key are fakes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const sponsor = Keypair.generate();
const h = vi.hoisted(() => ({
  takes: [] as { key: string; max: number; windowSecs: number }[][],
  signed: 0,
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
}));
vi.mock("server-only", () => ({}));
// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("../server/program", () => ({ assertProgram: async () => undefined, programProblem: async () => null }));
vi.mock("../agent/agent-wallet", () => ({
  hasAgentWallet: () => true,
  agentAddress: async () => sponsor.publicKey.toBase58(),
  agentCoSign: async (wireBase64: string) => { h.signed++; return { wireBase64, signature: "sig" }; },
}));
vi.mock("../agent/budget", () => ({ chainBackstop: async () => undefined }));
vi.mock("../server/shared-store", () => ({ takeShared: async (t: (typeof h.takes)[number]) => { h.takes.push(t); return { ok: true }; } }));
vi.mock("../chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint } };
});

const { getIdl } = await import("../chain/idl");
const ix = await import("../chain/instructions");
const { estatePda } = await import("../chain/pda");
const { DEFAULT_SPONSOR_LIMITS, SponsorLimiter } = await import("./limits");

const programId = new PublicKey(getIdl().address);
const mint = new PublicKey(h.mint);
const ctx = { programId, usdtMint: mint };
const conn = { getBalance: async () => 5e9, simulateTransaction: async () => ({ value: { err: null, logs: [] } }) };
let server: typeof import("./server");

function wire(ixs: TransactionInstruction[], signers: Keypair[]): string {
  const t = new Transaction({ feePayer: sponsor.publicKey, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" }).add(...ixs);
  t.partialSign(...signers);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
const sponsored = (w: string, ip?: string) => server.sponsorTransaction(w, { submit: false, ip }, conn as never)
  .then(() => "signed", (e: { name?: string; code?: string }) => e.code ?? e.name ?? "error");
const charged = () => h.takes.at(-1)!.filter((t) => t.key.startsWith("sponsor:day:")).map((t) => t.key.slice("sponsor:day:".length));

beforeEach(async () => {
  vi.resetModules();
  h.takes = [];
  h.signed = 0;
  server = await import("./server");
});

describe("only signers the transaction needs", () => {
  it("a throwaway signer added to the owner's check-in is refused", async () => {
    const owner = Keypair.generate(), throwaway = Keypair.generate();
    const t = ix.heartbeat(ctx, owner.publicKey);
    t.keys.push({ pubkey: throwaway.publicKey, isSigner: true, isWritable: false });
    expect(await sponsored(wire([t], [owner, throwaway]))).toBe("unneeded_signer");
    expect(h.signed).toBe(0);
  });

  it("a throwaway rent payer for a token account is refused", async () => {
    const sender = Keypair.generate(), payer = Keypair.generate(), to = Keypair.generate().publicKey;
    const { createAssociatedTokenAccountIdempotentInstruction: create } = await import("@solana/spl-token");
    const toAta = getAssociatedTokenAddressSync(mint, to, true);
    const ixs = [
      create(payer.publicKey, toAta, to, mint),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, sender.publicKey, true), mint, toAta, sender.publicKey, 1n, 6),
    ];
    expect(await sponsored(wire(ixs, [payer, sender]))).toBe("unneeded_signer");
  });

  it("a transfer is charged to the token's owner", async () => {
    const sender = Keypair.generate(), to = Keypair.generate().publicKey;
    const t = createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, sender.publicKey, true), mint, getAssociatedTokenAddressSync(mint, to, true), sender.publicKey, 5n, 6);
    expect(await sponsored(wire([t], [sender]))).toBe("signed");
    expect(charged()).toEqual([sender.publicKey.toBase58()]);
  });

  it("every signer is charged", async () => {
    const owner = Keypair.generate(), buyer = Keypair.generate();
    const estate = estatePda(programId, owner.publicKey);
    const both = [ix.heartbeat(ctx, owner.publicKey), ix.withdrawOffer(ctx, estate, Keypair.generate().publicKey, buyer.publicKey)];
    expect(await sponsored(wire(both, [owner, buyer]))).toBe("signed");
    expect(charged().sort()).toEqual([owner.publicKey.toBase58(), buyer.publicKey.toBase58()].sort());
  });
});

describe("the real actor's allowance can't be dodged", () => {
  it("146 co-signs that are never sent: one wallet stops at its day", async () => {
    const owner = Keypair.generate();
    const results: string[] = [];
    for (let i = 0; i < 146; i++) {
      vi.setSystemTime(Date.UTC(2026, 10, 23, 0, i)); // one a minute, so only the day's limit counts
      results.push(await sponsored(wire([ix.heartbeat(ctx, owner.publicKey)], [owner])));
    }
    vi.useRealTimers();
    expect(results.filter((r) => r === "signed")).toHaveLength(DEFAULT_SPONSOR_LIMITS.perDay);
  });

  it("a fresh caller every time cranks one estate only as often as one wallet could", async () => {
    const estate = estatePda(programId, Keypair.generate().publicKey);
    const results: string[] = [];
    for (let i = 0; i < DEFAULT_SPONSOR_LIMITS.perMinute + 5; i++) {
      const caller = Keypair.generate();
      results.push(await sponsored(wire([ix.finalizeUnlock(estate, caller.publicKey)], [caller])));
    }
    expect(results.filter((r) => r === "signed")).toHaveLength(DEFAULT_SPONSOR_LIMITS.perMinute);
    expect(charged()).toContain(`estate:${estate.toBase58()}`);
  });
});

describe("a day's cap per network address", () => {
  it("is in the shared takes for fees, and for rent when rent is sponsored", async () => {
    const owner = Keypair.generate();
    await sponsored(wire([ix.heartbeat(ctx, owner.publicKey)], [owner]), "198.51.100.4");
    expect(h.takes[0]).toEqual(expect.arrayContaining([{ key: "sponsor:ip:fees:198.51.100.4", max: DEFAULT_SPONSOR_LIMITS.ipFeesPerDay, windowSecs: 86_400 }]));
  });

  it("stops one address and leaves the others", () => {
    const limiter = new SponsorLimiter({ ...DEFAULT_SPONSOR_LIMITS, ipFeesPerDay: 5, ipRentPerDay: 2 });
    const t = 1_900_000_000_000;
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(`W${i}`, 10_000, false, t + i, "A")).toBeNull();
      limiter.record(`W${i}`, 10_000, false, t + i, "A");
    }
    expect(limiter.check("W9", 10_000, false, t + 9, "A")).toMatch(/network/);
    expect(limiter.check("W9", 10_000, false, t + 9, "B")).toBeNull();
  });

  it("one address can never use all of the day's fees or new accounts", () => {
    const { ipFeesPerDay, ipRentPerDay, dailyBudgetLamports } = DEFAULT_SPONSOR_LIMITS;
    expect(ipFeesPerDay).toBeLessThan((dailyBudgetLamports * 0.3) / 20_000);
    expect(ipRentPerDay).toBeLessThan(Math.floor((dailyBudgetLamports * 0.7) / 2_039_280));
  });
});
