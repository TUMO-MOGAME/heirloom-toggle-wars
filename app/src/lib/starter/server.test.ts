/**
 * Plan §18.3 S2: fifteen throwaway wallets used to empty the day. The grant and its route over a fake chain that
 * lands what is sent; the agent "wallet" signs nothing real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  agent: "",
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
  now: 0,
  accounts: new Map<string, { lamports: number; data: Buffer }>(),
  history: [] as { signature: string; blockTime: number; memo: string | null; err: null; keys: string[] }[],
  sent: [] as unknown[],
  shared: null as null | { ok: true } | { ok: false; retryAfterSecs: number },
  once: null as boolean | null,
  readFails: false,
  sendFails: false,
}));

// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("@/lib/server/program", () => ({ assertProgram: async () => undefined, programProblem: async () => null }));
vi.mock("../chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, dataMode: "chain", cluster: "devnet", usdtMint: h.mint } };
});
vi.mock("../server/shared-store", () => ({
  claimSharedOnce: async (key: string) => (key.startsWith("starter:") ? h.once : null),
  takeShared: async (takes: { key: string }[]) => (takes[0].key === "starter:all" ? h.shared : null),
}));
vi.mock("../agent/agent-wallet", () => ({
  hasAgentWallet: () => true,
  agentAddress: async () => h.agent,
  agentCoSign: async (wireBase64: string) => ({ wireBase64, signature: `grant${h.sent.length}` }),
}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => true }));
vi.mock("../chain/tx", async (original: () => Promise<object>) => {
  const { Transaction, SystemProgram, SystemInstruction, SendTransactionError } = await import("@solana/web3.js");
  const lamportsOf = (k: { toBase58(): string }) => h.accounts.get(k.toBase58())?.lamports ?? 0;
  const conn = {
    getBalance: async (k: PublicKey) => {
      if (h.readFails) throw new Error("429");
      return lamportsOf(k);
    },
    getAccountInfo: async (k: PublicKey) => h.accounts.get(k.toBase58()) ?? null,
    getSignaturesForAddress: async (k: PublicKey, o: { limit: number; before?: string; until?: string }) => {
      let rows = h.history.filter((t) => t.keys.includes(k.toBase58()));
      if (o.before) rows = rows.slice(rows.findIndex((t) => t.signature === o.before) + 1);
      const stop = o.until ? rows.findIndex((t) => t.signature === o.until) : -1;
      if (stop >= 0) rows = rows.slice(0, stop);
      return rows.slice(0, o.limit);
    },
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    sendRawTransaction: async (bytes: Uint8Array) => {
      if (h.sendFails) throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "failed", logs: [] });
      const tx = Transaction.from(bytes);
      h.sent.push(tx);
      let memo: string | null = null;
      for (const ix of tx.instructions) {
        const program = ix.programId.toBase58();
        if (ix.programId.equals(SystemProgram.programId)) {
          const { toPubkey, lamports } = SystemInstruction.decodeTransfer(ix);
          const was = h.accounts.get(toPubkey.toBase58());
          h.accounts.set(toPubkey.toBase58(), { lamports: (was?.lamports ?? 0) + Number(lamports), data: Buffer.alloc(0) });
        } else if (program.startsWith("AToken")) {
          const at = ix.keys[1].pubkey.toBase58();
          if (h.accounts.get(at)?.data.length) throw new Error("account already exists"); // lamports alone are no account
          h.accounts.set(at, { lamports: 1_488_440, data: Buffer.alloc(165) });
        } else if (program.startsWith("Memo")) {
          memo = `[${ix.data.length}] ${ix.data.toString("utf8")}`;
        }
      }
      h.history.unshift({
        signature: `landed${h.history.length}`, blockTime: Math.floor(h.now / 1000), memo, err: null,
        keys: tx.compileMessage().accountKeys.map((k) => k.toBase58()),
      });
      return "sent";
    },
  };
  return { ...(await original()), getConnection: () => conn, confirmOrThrow: async () => undefined };
});

const ONE_HOUR = 3_600_000;
let server: typeof import("./server");
let visitor = 0;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("AGENT_SEED_PHRASE", "stand-in words for a test only");
  vi.useFakeTimers({ toFake: ["Date"] });
  h.now = Date.UTC(2026, 10, 27, 8);
  vi.setSystemTime(h.now);
  Object.assign(h, { agent: Keypair.generate().publicKey.toBase58(), history: [], sent: [], shared: null, once: null, readFails: false, sendFails: false });
  h.accounts.clear();
  h.accounts.set(h.agent, { lamports: 5_000_000_000, data: Buffer.alloc(0) });
  const { ata } = await import("../chain/pda");
  const held = Buffer.alloc(165);
  held.writeBigUInt64LE(100_000_000_000n, 64);
  h.accounts.set(ata(h.mint, h.agent).toBase58(), { lamports: 1_488_440, data: held });
  server = await import("./server");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const later = (ms: number) => vi.setSystemTime((h.now += ms));
const person = () => Keypair.generate().publicKey.toBase58();
const ask = (wallet = person()) =>
  server.grantStarter(wallet).then(() => "granted", (e: { code?: string }) => e.code ?? String(e));

describe("pacing read from the chain", () => {
  it("fifteen throwaway wallets in a burst take one hour's share, and a visitor gets in the next hour", async () => {
    const burst: string[] = [];
    for (let i = 0; i < 15; i++) burst.push(await ask());
    expect(burst.filter((r) => r === "granted")).toHaveLength(server.STARTER.perHour);
    expect(new Set(burst.slice(server.STARTER.perHour))).toEqual(new Set(["hourly_cap"]));
    later(ONE_HOUR + 1_000);
    expect(await ask()).toBe("granted");
  });

  it("a burst can never take more than a quarter of the day", () => {
    expect(server.STARTER.perHour * 4).toBeLessThanOrEqual(server.STARTER.perDay);
  });

  it("the day's pace holds, and says when it frees", async () => {
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < server.STARTER.perHour; i++) expect(await ask()).toBe("granted");
      later(ONE_HOUR + 1_000);
    }
    const refused = await server.grantStarter(person()).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 429, code: "daily_cap", retryAfterSecs: 86_400 - 4 * 3_601 });
    expect((refused as Error).message).toContain("faucet.solana.com");
  });

  it("the count survives a restart", async () => {
    for (let i = 0; i < server.STARTER.perHour; i++) await ask();
    vi.resetModules();
    server = await import("./server");
    expect(await ask()).toBe("hourly_cap");
  });

  it("forged memos that mention the agent don't count", async () => {
    for (let i = 0; i < 100; i++) {
      h.history.unshift({
        signature: `forged${i}`, blockTime: Math.floor(h.now / 1000), err: null, keys: [h.agent],
        memo: i % 2 ? "[16] heirloom-starter" : `heirloom-starter:${Math.floor(h.now / 1000) - i}:80000000:${"a".repeat(16)}:${"b".repeat(32)}`,
      });
    }
    expect(await ask()).toBe("granted");
  });

  it("requests arriving together can't all take the last place", async () => {
    // One place left, five asking at once (more would be turned away by the queue, not by the pace).
    for (let i = 1; i < server.STARTER.perHour; i++) expect(await ask()).toBe("granted");
    const all = await Promise.all(Array.from({ length: 5 }, () => ask()));
    expect(all.filter((r) => r === "granted")).toHaveLength(1);
  });
});

describe("the grant", () => {
  it("sends SOL, a new USD₮ account and the marked memo, and nothing about an IP address", async () => {
    const wallet = person();
    expect(await server.grantStarter(wallet)).toMatchObject({ sol: server.STARTER.lamports / 1e9, usdt: 500 });
    const tx = h.sent[0] as Transaction;
    const programs = tx.instructions.map((i) => i.programId.toBase58().slice(0, 6));
    expect(programs).toEqual(["Comput", "111111", "AToken", "Tokenk", "MemoSq"]);
    // Create, not CreateIdempotent: a second grant to the same wallet fails on-chain.
    expect(tx.instructions[2].data).toHaveLength(0);
    expect(tx.instructions[4].keys).toHaveLength(0);
    expect(tx.instructions[4].data.toString("utf8")).toMatch(/^heirloom-starter:\d+:\d+:[0-9a-f]{16}:[0-9a-f]{32}$/);
  });

  it("a wallet that already holds USD₮ but was never granted is told so, not that it had its test money", async () => {
    const wallet = person();
    const { ata } = await import("../chain/pda");
    h.accounts.set(ata(h.mint, wallet).toBase58(), { lamports: 2_039_280, data: Buffer.alloc(165) });
    expect(await ask(wallet)).toBe("has_usdt_account");
    expect(h.sent).toHaveLength(0);
  });

  it("lamports sent to a wallet's token-account address don't block its grant", async () => {
    const wallet = person();
    const { ata } = await import("../chain/pda");
    h.accounts.set(ata(h.mint, wallet).toBase58(), { lamports: 1_000, data: Buffer.alloc(0) });
    expect(await ask(wallet)).toBe("granted");
  });

  it("is once per wallet", async () => {
    const wallet = person();
    expect(await ask(wallet)).toBe("granted");
    expect(await ask(wallet)).toBe("already_funded");
  });

  it("even after the wallet empties and closes its account", async () => {
    const wallet = person();
    await ask(wallet);
    const { ata } = await import("../chain/pda");
    h.accounts.delete(wallet);
    h.accounts.delete(ata(h.mint, wallet).toBase58());
    later(3 * 24 * ONE_HOUR);
    vi.resetModules();
    server = await import("./server");
    expect(await ask(wallet)).toBe("already_funded");
  });

  it("two requests at once for one wallet pay once", async () => {
    const wallet = person();
    expect((await Promise.all([ask(wallet), ask(wallet)])).sort()).toEqual(["already_funded", "granted"]);
  });

  it("a wallet with faucet SOL gets only the USD₮", async () => {
    const wallet = person();
    h.accounts.set(wallet, { lamports: 1_000_000_000, data: Buffer.alloc(0) });
    expect(await server.grantStarter(wallet)).toMatchObject({ sol: 0 });
    expect((h.sent[0] as Transaction).instructions.some((i) => i.programId.equals(SystemProgram.programId))).toBe(false);
  });

  it("refuses a program's address, and the agent itself", async () => {
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], SystemProgram.programId)[0].toBase58();
    expect(await ask(pda)).toBe("bad_wallet");
    expect(await ask(h.agent)).toBe("bad_wallet");
  });

  it("keeps the agent's reserve", async () => {
    h.accounts.set(h.agent, { lamports: server.STARTER.reserveLamports + server.STARTER.lamports, data: Buffer.alloc(0) });
    expect(await ask()).toBe("empty");
  });

  it("a busy RPC is a retry, never a grant and never 'empty'", async () => {
    h.readFails = true;
    const refused = await server.grantStarter(person()).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 503, code: "busy", retryAfterSecs: 30 });
    expect(h.sent).toHaveLength(0);
  });

  it("a grant refused in preflight gives its place back", async () => {
    h.sendFails = true;
    expect(await ask()).toBe("busy");
    h.sendFails = false;
    for (let i = 0; i < server.STARTER.perHour; i++) expect(await ask()).toBe("granted");
  });

  it("a history too flooded to count waits rather than guesses", async () => {
    const at = Math.floor(h.now / 1000);
    h.history = Array.from({ length: 10_500 }, (_, i) => ({ signature: `m${i}`, blockTime: at, memo: null, err: null, keys: [h.agent] }));
    expect(await ask()).toBe("busy");
    expect(h.sent).toHaveLength(0);
  });

  it("obeys the shared store when there is one", async () => {
    h.shared = { ok: false, retryAfterSecs: 120 };
    expect(await ask()).toBe("hourly_cap");
    h.shared = { ok: false, retryAfterSecs: 20_000 };
    expect(await ask()).toBe("daily_cap");
    h.shared = { ok: true };
    h.once = false; // another instance is granting this wallet right now
    expect(await ask()).toBe("busy");
    expect(h.sent).toHaveLength(0);
  });
});

describe("POST /api/starter", () => {
  function signer() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
    return { address, signMessage: async (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
  }

  async function post(opts: { proof?: "none" | "other-wallet" | "old"; ip?: string } = {}) {
    const who = signer();
    const { actionHeaders } = await import("../access/client");
    const { actionBody } = await import("../access/messages");
    const { POW, solveProof } = await import("./pow");
    const { POST } = await import("@/app/api/starter/route");
    const proof = opts.proof === "none" ? undefined : await solveProof(
      opts.proof === "other-wallet" ? person() : who.address,
      opts.proof === "old" ? h.now - 3 * POW.windowMs : h.now,
      async () => undefined,
    );
    return POST(new Request("http://t/api/starter", {
      method: "POST",
      headers: {
        "x-forwarded-for": opts.ip ?? `198.51.100.${++visitor}`, // each from its own network unless told
        ...(await actionHeaders(who, "starter", who.address, actionBody.starter(), h.now)),
      },
      body: JSON.stringify({ wallet: who.address, proof }),
    }));
  }

  it.each(["none", "other-wallet", "old"] as const)("refuses a proof of work that is %s, sending nothing", async (proof) => {
    const res = await post({ proof });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "proof", retryAfter: 1 });
    expect(h.sent).toHaveLength(0);
  });

  it("grants with one", async () => {
    expect((await post()).status).toBe(200);
    expect(h.sent).toHaveLength(1);
  });

  it("one address takes 4 an hour, and another address is still served (H2)", async () => {
    const codes: (string | number)[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post({ ip: "203.0.113.7" });
      codes.push(res.status === 200 ? 200 : ((await res.json()) as { code: string }).code);
    }
    expect(codes).toEqual([200, 200, 200, 200, "rate_limited", "rate_limited"]);
    expect((await post({ ip: "203.0.113.8" })).status).toBe(200);
  });

  it("and 8 a day, however the hours fall", async () => {
    let granted = 0;
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < 4; i++) if ((await post({ ip: "203.0.113.9" })).status === 200) granted++;
      later(ONE_HOUR + 1_000);
    }
    expect(granted).toBe(server.STARTER.perIpDay);
  });

  it("a room of ten, each on their own phone, is served across the hour", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await post({ ip: `192.0.2.${i + 1}` })).status);
      later(6 * 60_000);
    }
    expect(statuses).toEqual(Array(10).fill(200));
  });

  it("an address that took its four leaves the hour to everyone else", async () => {
    for (let i = 0; i < 6; i++) await post({ ip: "203.0.113.10" });
    const others: number[] = [];
    for (let i = 0; i < server.STARTER.perHour - server.STARTER.perIpHour; i++) others.push((await post()).status);
    expect(others).toEqual(Array(server.STARTER.perHour - server.STARTER.perIpHour).fill(200));
  });

  it("the client's refusal keeps the code and the time", async () => {
    const { StarterError, requestStarterFunds } = await import("./client");
    const answer = async () => new Response(JSON.stringify({ error: "no", code: "hourly_cap", retryAfter: 900 }), { status: 429 });
    const error = await requestStarterFunds(signer(), answer as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StarterError);
    expect(error).toMatchObject({ code: "hourly_cap", retryAfterSecs: 900 });
  });
});

