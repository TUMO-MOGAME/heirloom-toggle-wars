/**
 * Plan §18.3 S6: the replaced production dependencies still do what their real consumers need.
 * bigint-buffer → vendor/bigint-buffer (GHSA-3gc7-fjrx-p6mg, no fixed release); jayson 4 → 5 (drops uuid and
 * stream-json); toml 3 → 5 (read only by Anchor's Node workspace helper).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, MintLayout, createTransferCheckedInstruction, decodeTransferCheckedInstruction } from "@solana/spl-token";
import { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } from "bigint-buffer";

const require = createRequire(import.meta.url);

describe("bigint-buffer replacement", () => {
  it("converts both ways at every width the layouts use", () => {
    for (const width of [1, 8, 16, 24, 32]) {
      const max = (1n << BigInt(8 * width)) - 1n;
      for (const v of [0n, 1n, 255n, max / 3n, max - 1n, max]) {
        expect(toBigIntLE(toBufferLE(v, width))).toBe(v);
        expect(toBigIntBE(toBufferBE(v, width))).toBe(v);
      }
    }
    expect([...toBufferLE(258n, 4)]).toEqual([2, 1, 0, 0]);
    expect([...toBufferBE(258n, 4)]).toEqual([0, 0, 1, 2]);
  });

  it("reads empty, odd-sized and large input without overflowing or changing it", () => {
    expect(toBigIntLE(Buffer.alloc(0))).toBe(0n);
    expect(toBufferLE(0n, 0)).toHaveLength(0);
    const input = Buffer.alloc(4097, 0xff);
    expect(toBigIntLE(input)).toBe((1n << 32776n) - 1n);
    const ordered = Buffer.from([1, 2, 3]);
    expect(toBigIntLE(ordered)).toBe(0x030201n);
    expect([...ordered]).toEqual([1, 2, 3]);
  });

  it("refuses what does not fit, and what is not a bigint", () => {
    expect(() => toBufferLE(1n << 64n, 8)).toThrow(RangeError);
    expect(() => toBufferBE(-1n, 8)).toThrow(RangeError);
    expect(() => toBufferLE(1n, -1)).toThrow(RangeError);
    expect(() => toBufferLE(1 as unknown as bigint, 8)).toThrow(TypeError);
  });

  it("is what spl-token uses, and spl-token's layouts still round-trip", () => {
    const utils = createRequire(require.resolve("@solana/buffer-layout-utils"));
    expect(utils("bigint-buffer/package.json").version).toBe("2.0.0-heirloom.1");

    const [a, b, c, owner] = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
    const amount = 18_446_744_073_709_551_615n;
    const ix = createTransferCheckedInstruction(a, b, c, owner, amount, 6);
    expect(decodeTransferCheckedInstruction(ix).data.amount).toBe(amount);
    expect(() => createTransferCheckedInstruction(a, b, c, owner, amount + 1n, 6)).toThrow();

    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({
      mint: b, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
      isNative: 0n, delegatedAmount: 7n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    }, data);
    expect(AccountLayout.decode(data)).toMatchObject({ amount, delegatedAmount: 7n, state: 1 });

    const mint = Buffer.alloc(MintLayout.span);
    MintLayout.encode({
      mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1n, decimals: 0, isInitialized: true,
      freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
    }, mint);
    expect(MintLayout.decode(mint).supply).toBe(1n);
  });
});

describe("jayson 5 under web3.js", () => {
  const connection = (answer: (id: unknown, method: string) => object, seen: unknown[]) =>
    new Connection("https://rpc.invalid", {
      disableRetryOnRateLimit: true,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { id: unknown; method: string } | { id: unknown; method: string }[];
        seen.push(body);
        const one = (r: { id: unknown; method: string }) => ({ jsonrpc: "2.0", id: r.id, ...answer(r.id, r.method) });
        return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
      },
    });

  it("sends a JSON-RPC 2.0 request with a fresh id and reads the result", async () => {
    const seen: { id: string; jsonrpc: string; method: string }[] = [];
    const conn = connection(() => ({ result: { context: { slot: 1 }, value: 42 } }), seen);
    const who = Keypair.generate().publicKey;
    expect(await conn.getBalance(who)).toBe(42);
    expect(await conn.getBalance(who)).toBe(42);
    expect(seen[0]).toMatchObject({ jsonrpc: "2.0", method: "getBalance" });
    expect(seen[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1].id).not.toBe(seen[0].id);
  });

  it("passes an RPC error through", async () => {
    const conn = connection(() => ({ error: { code: -32602, message: "Invalid param" } }), []);
    await expect(conn.getBalance(Keypair.generate().publicKey)).rejects.toThrow(/Invalid param/);
  });

  it("still batches", async () => {
    const seen: unknown[] = [];
    const conn = connection(() => ({ result: null }), seen);
    const sigs = ["1".repeat(64), "1".repeat(63) + "2"];
    expect(await conn.getParsedTransactions(sigs, "confirmed")).toEqual([null, null]);
    expect(seen[0]).toHaveLength(2);
  });
});

describe("toml 5 under @anchor-lang/core", () => {
  const toml = createRequire(require.resolve("@anchor-lang/core"))("toml") as { parse(text: string): Record<string, never> };

  it("gives the workspace helper the fields it reads from our Anchor.toml", () => {
    const parsed = toml.parse(readFileSync(path.resolve(process.cwd(), "../Anchor.toml"), "utf8")) as unknown as {
      provider: { cluster: string }; programs: Record<string, Record<string, string>>;
    };
    expect(parsed.provider.cluster).toBe("devnet");
    expect(Object.entries(parsed.programs.devnet)).toEqual([["heirloom", "b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY"]]);
  });

  it("no longer lets a document write to Object.prototype", () => {
    try { toml.parse("[__proto__]\npolluted = 1"); } catch { /* refusing is fine too */ }
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });
});
