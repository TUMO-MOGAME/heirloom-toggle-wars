/** Plan §18.3 S3: the sponsor's allowances across instances, and the chain's backstop without a shared store. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getIdl } from "../chain/idl";
import * as ix from "../chain/instructions";
import { TOKEN_ACCOUNT_RENT } from "./policy";
import { DEFAULT_SPONSOR_LIMITS, sharedTakes } from "./limits";

const sponsor = Keypair.generate();
const h = vi.hoisted(() => ({
  taken: null as null | { ok: true } | { ok: false; retryAfterSecs: number },
  takes: [] as { key: string; max: number; windowSecs: number }[][],
  backstop: null as Error | null,
  backstops: 0,
  signed: 0,
  simError: null as unknown,
  logs: [] as string[],
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
}));

// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("@/lib/server/program", () => ({ assertProgram: async () => undefined, programProblem: async () => null }));
vi.mock("server-only", () => ({}));
vi.mock("../agent/agent-wallet", () => ({
  hasAgentWallet: () => true,
  agentAddress: async () => sponsor.publicKey.toBase58(),
  agentCoSign: async (wireBase64: string) => { h.signed++; return { wireBase64, signature: "sig" }; },
}));
vi.mock("../agent/budget", () => ({ chainBackstop: async () => { h.backstops++; if (h.backstop) throw h.backstop; } }));
vi.mock("../server/shared-store", () => ({
  takeShared: async (takes: (typeof h.takes)[number]) => { h.takes.push(takes); return h.taken; },
}));
vi.mock("../chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint } };
});

const ctx = { programId: new PublicKey(getIdl().address), usdtMint: new PublicKey(h.mint) };
const conn = {
  getBalance: async () => 5e9,
  simulateTransaction: async (tx: VersionedTransaction) => ({ value: { err: tx ? h.simError : null, logs: h.logs } }),
};

let server: typeof import("./server");
function tx(user = Keypair.generate()): string {
  const t = new Transaction({ feePayer: sponsor.publicKey, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" })
    .add(ix.heartbeat(ctx, user.publicKey));
  t.partialSign(user);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
const sponsored = (wire = tx()) => server.sponsorTransaction(wire, { submit: false }, conn as never);

beforeEach(async () => {
  vi.resetModules();
  Object.assign(h, { taken: { ok: true }, takes: [], backstop: null, backstops: 0, signed: 0, simError: null, logs: [] });
  server = await import("./server");
});

describe("the sponsor's allowance", () => {
  it("takes the shared allowances before it signs", async () => {
    await sponsored();
    expect([h.signed, h.backstops]).toEqual([1, 0]);
    expect(h.takes[0].map((t) => t.key.replace(/:[1-9A-HJ-NP-Za-km-z]{32,}$/, ""))).toEqual(["sponsor:minute", "sponsor:day", "sponsor:fees"]);
  });

  it.each([["", 300_000_000], ["25000000", 25_000_000]])("SPONSOR_DAILY_BUDGET_LAMPORTS=%j: the takes follow a budget of %i", async (env, budget) => {
    vi.stubEnv("SPONSOR_DAILY_BUDGET_LAMPORTS", env);
    await sponsored();
    vi.unstubAllEnvs();
    expect(h.takes[0]).toEqual(sharedTakes("W", false, { ...DEFAULT_SPONSOR_LIMITS, dailyBudgetLamports: budget }, 20_000)
      .map((t) => ({ ...t, key: expect.any(String) })));
  });

  it("refuses when another instance used them up, and signs nothing", async () => {
    h.taken = { ok: false, retryAfterSecs: 30 };
    await expect(sponsored()).rejects.toMatchObject({ name: "SponsorLimited" });
    expect(h.signed).toBe(0);
  });

  it("without a shared store: the chain's backstop decides", async () => {
    h.taken = null;
    await sponsored();
    expect([h.signed, h.backstops]).toEqual([1, 1]);
    h.backstop = new Error("spending limit");
    await expect(sponsored()).rejects.toThrow(/spending limit/);
    expect(h.signed).toBe(1);
  });

  it("a refusal gives this instance's allowance back", async () => {
    const user = Keypair.generate();
    const wire = tx(user);
    h.taken = { ok: false, retryAfterSecs: 30 };
    for (let i = 0; i < DEFAULT_SPONSOR_LIMITS.perMinute + 1; i++) {
      await expect(sponsored(wire)).rejects.toThrow(/used up/); // never "wait a minute" from this instance
    }
  });

  it("requests arriving together can't pass the limit together", async () => {
    const wire = tx();
    const results = await Promise.allSettled(Array.from({ length: DEFAULT_SPONSOR_LIMITS.perMinute + 4 }, () => sponsored(wire)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(DEFAULT_SPONSOR_LIMITS.perMinute);
  });

  it("what fails simulation uses no allowance and says why in plain words", async () => {
    h.simError = { InstructionError: [0, { Custom: 6059 }] };
    await expect(sponsored()).rejects.toThrow(/^Rejected by the Heirloom program: DeathReportOpen: /);
    expect([h.takes.length, h.signed]).toEqual([0, 0]);
  });
});

describe("sharedTakes", () => {
  it.each([300_000_000, 100_000_000, 25_000_000])("their worst case stays inside a budget of %i lamports", (dailyBudgetLamports) => {
    const limits = { ...DEFAULT_SPONSOR_LIMITS, dailyBudgetLamports };
    const max = (key: string) => sharedTakes("W", true, limits, 20_000).find((t) => t.key === key)!.max;
    expect(max("sponsor:fees") * 20_000 + max("sponsor:rent") * TOKEN_ACCOUNT_RENT).toBeLessThanOrEqual(dailyBudgetLamports);
  });

  it("rent has allowances of its own, per wallet and for all", () => {
    expect(sharedTakes("W", false, DEFAULT_SPONSOR_LIMITS, 20_000).some((t) => t.key.includes("rent"))).toBe(false);
    expect(sharedTakes("W", true, DEFAULT_SPONSOR_LIMITS, 20_000).map((t) => t.key)).toEqual(expect.arrayContaining(["sponsor:rent:W", "sponsor:rent"]));
  });
});
