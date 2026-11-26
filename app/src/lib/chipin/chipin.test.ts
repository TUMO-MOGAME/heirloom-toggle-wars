/**
 * Chip in (plan §21): the Solana Pay transaction request / Solana Action that adds USD₮ to a vault from any wallet.
 * The route builds exactly one transfer_checked (mint, vault ATA, amount in base units, payer, tag + reference as
 * read-only non-signers), refuses everything else, answers the Actions and Solana Pay shapes with CORS; the demo
 * simulates the same, marked simulated. The network is a fake; the Estate account is encoded with the real IDL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction } from "@solana/spl-token";

const h = vi.hoisted(() => ({
  chain: true,
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
  raw: new Map<string, { owner: unknown; data: Uint8Array }>(),
  parsed: new Map<string, unknown>(),
  lamports: new Map<string, number>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => h.chain, rateLimit: () => undefined, rateLimitShared: async () => undefined }));
vi.mock("@/lib/chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint, cluster: "devnet" } };
});
vi.mock("@/lib/chain/tx", async (original: () => Promise<object>) => ({ ...(await original()), getConnection: () => fakeConn() }));

function fakeConn() {
  return {
    getAccountInfo: async (k: PublicKey) => h.raw.get(k.toBase58()) ?? null,
    getParsedAccountInfo: async (k: PublicKey) => {
      const p = h.parsed.get(k.toBase58());
      return { context: { slot: 1 }, value: p ? { owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, data: { program: "spl-token", parsed: p, space: 165 } } : null };
    },
    getBalance: async (k: PublicKey) => h.lamports.get(k.toBase58()) ?? 0,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
  };
}

const { getCoder, getIdl } = await import("../chain/idl");
const { ata, estatePda, vaultAta } = await import("../chain/pda");
const { checkChipInAmount, chipInTag, chipInApiUrl, isAddress, solanaPayUrl, MAX_CHIP_IN_USDT } = await import("./link");
const { buildChipIn, ChipInError } = await import("./build");
const { ACTIONS_CORS_HEADERS, ACTIONS_JSON, chipInGet } = await import("./actions");
const { findChipIns } = await import("./find");
const { qrPath } = await import("./qr-path");
const route = await import("@/app/api/chipin/[estate]/route");
const actionsJson = await import("@/app/actions.json/route");
const { createMockService, DEMO_PERSONAS } = await import("../service/mock");

const programId = new PublicKey(getIdl().address);
const k = () => Keypair.generate().publicKey;
const bn = (n: number) => new BN(String(n));

let owner: PublicKey, estate: PublicKey, vault: PublicKey, payer: PublicKey;

async function putEstate(status: string, mint = h.mint) {
  const data = await getCoder().accounts.encode("Estate", {
    owner, agent: k(), usdt_mint: new PublicKey(mint), verifiers: [k(), k(), k()], death_threshold: 2, claim_threshold: 1,
    hardship_threshold: 2, waiting_period_secs: bn(120), status: { [status]: {} }, will_hash: Array(32).fill(0), will_uri: "",
    death_cert_hash: Array(32).fill(0), death_submitted_by: PublicKey.default, death_verdict: { Pending: {} }, death_attestations: 0,
    death_pending_since: bn(0), last_heartbeat: bn(0), rule_count: 1, bump: 255,
  });
  h.raw.set(estate.toBase58(), { owner: programId, data });
}
const tokenAccount = (mint: string, ownerKey: string, amount: bigint, state = "initialized") =>
  ({ type: "account", info: { mint, owner: ownerKey, state, tokenAmount: { amount: amount.toString(), decimals: 6 } } });

beforeEach(async () => {
  h.chain = true;
  h.raw.clear(); h.parsed.clear(); h.lamports.clear();
  owner = k(); payer = k();
  estate = estatePda(programId, owner);
  vault = vaultAta(h.mint, estate);
  await putEstate("Active");
  h.parsed.set(h.mint, { type: "mint", info: { decimals: 6, isInitialized: true } });
  h.parsed.set(vault.toBase58(), tokenAccount(h.mint, estate.toBase58(), 0n));
  h.parsed.set(ata(h.mint, payer).toBase58(), tokenAccount(h.mint, payer.toBase58(), 500_000_000n));
  h.lamports.set(payer.toBase58(), 1_000_000);
});

const post = (query: string, body: unknown, at = estate.toBase58()) =>
  route.POST(new Request(`https://heirloom.test/api/chipin/${at}${query}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ estate: at }) });
const get = (at = estate.toBase58()) =>
  route.GET(new Request(`https://heirloom.test/api/chipin/${at}`), { params: Promise.resolve({ estate: at }) });

describe("links (Solana Pay transaction request)", () => {
  it("URL-encodes a link with query parameters and leaves a bare one as it is", () => {
    const bare = chipInApiUrl("https://heirloom.test", estate.toBase58());
    expect(solanaPayUrl(bare)).toBe(`solana:${bare}`);
    const withQ = chipInApiUrl("https://heirloom.test", estate.toBase58(), { amount: 50, reference: payer.toBase58() });
    expect(solanaPayUrl(withQ)).toBe(`solana:${encodeURIComponent(withQ)}`);
    expect(decodeURIComponent(solanaPayUrl(withQ).slice(7))).toBe(withQ);
    expect(() => solanaPayUrl("http://heirloom.test/api/chipin/x")).toThrow(/https/);
  });

  it("gives each estate one fixed tag, a 32-byte address, different from the estate", () => {
    const tag = chipInTag(estate.toBase58());
    expect(chipInTag(estate.toBase58())).toBe(tag);
    expect(bs58.decode(tag)).toHaveLength(32);
    expect(tag).not.toBe(estate.toBase58());
    expect(chipInTag(k().toBase58())).not.toBe(tag);
  });

  it("reads amounts with the app's strict parser and the limit", () => {
    expect(checkChipInAmount("50")).toEqual({ ok: true, base: 50_000_000n, usdt: 50 });
    expect(checkChipInAmount("12,50")).toMatchObject({ ok: true, base: 12_500_000n });
    expect(checkChipInAmount(String(MAX_CHIP_IN_USDT))).toMatchObject({ ok: true });
    expect(checkChipInAmount("10000.01")).toEqual({ ok: false, code: "amount_too_big" });
    expect(checkChipInAmount("1.000")).toEqual({ ok: false, code: "amount_unclear" });
    expect(checkChipInAmount("-5")).toEqual({ ok: false, code: "amount_unclear" });
    expect(checkChipInAmount("0")).toEqual({ ok: false, code: "amount_zero" });
    expect(checkChipInAmount("0.0000001")).toEqual({ ok: false, code: "amount_unclear" });
    expect(checkChipInAmount(null)).toEqual({ ok: false, code: "amount_missing" });
  });

  it("knows an address from anything else", () => {
    expect(isAddress(payer.toBase58())).toBe(true);
    for (const bad of ["", "abc", "0OIl".repeat(11), 42, null, `${payer.toBase58()}x`]) expect(isAddress(bad)).toBe(false);
  });
});

describe("POST builds exactly one transfer into the vault", () => {
  it("transfer_checked: payer's USD₮ account → vault ATA, configured mint, base units, 6 decimals, tag and reference", async () => {
    const reference = k().toBase58();
    const res = await post(`?amount=12,5&reference=${reference}`, { account: payer.toBase58() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("transaction");
    expect(body.message).toMatch(/12,5 USD₮|12.5 USD₮|12,50 USD₮|12.50 USD₮/);
    expect(body.message).toContain("Heirloom vault");
    const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
    expect(tx.feePayer?.equals(payer)).toBe(true);
    expect(tx.recentBlockhash).toBeTruthy();
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0];
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    const d = decodeTransferCheckedInstruction(ix);
    expect(d.keys.source.pubkey.equals(ata(h.mint, payer))).toBe(true);
    expect(d.keys.mint.pubkey.toBase58()).toBe(h.mint);
    expect(d.keys.destination.pubkey.equals(vault)).toBe(true);
    expect(d.keys.owner.pubkey.equals(payer)).toBe(true);
    expect(d.keys.owner.isSigner).toBe(true);
    expect(d.data.amount).toBe(12_500_000n);
    expect(d.data.decimals).toBe(6);
    const [tag, ref] = d.keys.multiSigners;
    expect(tag.pubkey.toBase58()).toBe(chipInTag(estate.toBase58()));
    expect(ref.pubkey.toBase58()).toBe(reference);
    for (const x of [tag, ref]) { expect(x.isSigner).toBe(false); expect(x.isWritable).toBe(false); }
    // The only signer the wallet is asked for is its own account.
    expect(tx.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("makes a fresh reference when the link has none, and reads the amount from Actions' data too", async () => {
    const res = await post("", { account: payer.toBase58(), data: { amount: "25" } });
    expect(res.status).toBe(200);
    const d = decodeTransferCheckedInstruction(Transaction.from(Buffer.from((await res.json()).transaction, "base64")).instructions[0]);
    expect(d.data.amount).toBe(25_000_000n);
    expect(isAddress(d.keys.multiSigners[1].pubkey.toBase58())).toBe(true);
  });

  it.each([
    ["?amount=0", "amount_zero"], ["?amount=10001", "amount_too_big"], ["?amount=1.000", "amount_unclear"], ["", "amount_missing"],
    ["?amount=abc", "amount_unclear"], ["?amount=5&reference=nope", "bad_reference"],
  ])("refuses %s (%s)", async (q, code) => {
    const res = await post(q, { account: payer.toBase58() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code, message: expect.any(String) });
  });

  it("refuses a bad account: not base58, not 32 bytes, missing, the estate or the vault itself", async () => {
    for (const account of ["not-a-key", "1111", 12, undefined, estate.toBase58(), vault.toBase58()]) {
      const res = await post("?amount=5", { account });
      expect(res.status, String(account)).toBe(400);
      expect((await res.json()).code).toBe("bad_account");
    }
    expect((await (await route.POST(new Request(`https://heirloom.test/api/chipin/${estate}?amount=5`, { method: "POST", body: "{" }), { params: Promise.resolve({ estate: estate.toBase58() }) })).json()).code).toBe("bad_account");
  });

  it("refuses an estate that is not Active", async () => {
    for (const status of ["DeathPending", "Unlocked", "Frozen"]) {
      await putEstate(status);
      const res = await post("?amount=5", { account: payer.toBase58() });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("not_active");
    }
  });

  it("refuses a wrong mint: an estate on another mint, a mint that isn't 6 decimals, or one that doesn't exist", async () => {
    const other = k().toBase58();
    await putEstate("Active", other);
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("token_unverified");
    await putEstate("Active");
    h.parsed.set(h.mint, { type: "mint", info: { decimals: 9 } });
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("token_unverified");
    h.parsed.delete(h.mint);
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("token_unverified");
  });

  it("refuses what is not this program's estate, and a vault that isn't the estate's", async () => {
    h.raw.set(estate.toBase58(), { owner: k(), data: h.raw.get(estate.toBase58())!.data });
    expect((await post("?amount=5", { account: payer.toBase58() })).status).toBe(404);
    await putEstate("Active");
    h.parsed.set(vault.toBase58(), tokenAccount(h.mint, k().toBase58(), 0n));
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("no_vault");
    expect((await post("?amount=5", { account: payer.toBase58() }, "bad")).status).toBe(404);
  });

  it("says when the wallet can't pay: no USD₮ account, too little, frozen, no SOL", async () => {
    expect((await (await post("?amount=501", { account: payer.toBase58() })).json()).code).toBe("not_enough_usdt");
    h.lamports.set(payer.toBase58(), 0);
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("no_sol");
    h.parsed.set(ata(h.mint, payer).toBase58(), tokenAccount(h.mint, payer.toBase58(), 9_000_000n, "frozen"));
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("no_usdt");
    h.parsed.delete(ata(h.mint, payer).toBase58());
    expect((await (await post("?amount=5", { account: payer.toBase58() })).json()).code).toBe("no_usdt");
  });

  it("builds nothing on the demo site", async () => {
    h.chain = false;
    const res = await post("?amount=5", { account: payer.toBase58() });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("demo");
  });

  it("the builder throws ChipInError, never a half-built transaction", async () => {
    await expect(buildChipIn(fakeConn() as never, { estate: estate.toBase58(), account: payer.toBase58(), amount: "0", expectMint: h.mint, cluster: "devnet", newReference: () => k().toBase58() }))
      .rejects.toBeInstanceOf(ChipInError);
  });
});

describe("GET, OPTIONS and actions.json (Solana Actions + Solana Pay metadata)", () => {
  it("answers both shapes: label + icon for Solana Pay, the Action with presets and a custom amount", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ type: "action", label: "Heirloom vault", title: expect.any(String), description: expect.any(String) });
    expect(body.icon).toBe("https://heirloom.test/icons/apple-touch-icon.png");
    expect(body.disabled).toBeUndefined();
    const hrefs = body.links.actions.map((a: { href: string }) => a.href);
    expect(hrefs).toEqual([25, 50, 100].map((n) => `/api/chipin/${estate}?amount=${n}`).concat(`/api/chipin/${estate}?amount={amount}`));
    const custom = body.links.actions[3];
    expect(custom).toMatchObject({ type: "transaction", parameters: [{ name: "amount", required: true, type: "number", max: MAX_CHIP_IN_USDT }] });
    // No names: only the generic label.
    expect(JSON.stringify(body)).not.toMatch(/Mokoena|Thabo/);
  });

  it("sends the Actions CORS headers, the version and the chain id", async () => {
    const res = await get();
    for (const [name, value] of Object.entries(ACTIONS_CORS_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("x-blockchain-ids")).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(res.headers.get("x-action-version")).toBeTruthy();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const pre = route.OPTIONS();
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,OPTIONS");
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/Content-Type, Authorization, Content-Encoding, Accept-Encoding/);
  });

  it("shows the action disabled, with the reason, when the vault can't take one; demo is always disabled", async () => {
    await putEstate("Unlocked");
    const body = await (await get()).json();
    expect(body.disabled).toBe(true);
    expect(body.error.message).toMatch(/not taking chip-ins/);
    expect(body.links).toBeUndefined();
    h.chain = false;
    const demo = await (await get()).json();
    expect(demo).toMatchObject({ disabled: true, error: { message: expect.stringMatching(/demo/) } });
    expect((await get("nope")).status).toBe(404);
  });

  it("serves /actions.json with CORS: the public page maps to the API", async () => {
    const res = actionsJson.GET();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ rules: [{ pathPattern: "/chip-in/*", apiPath: "/api/chipin/*" }] });
    expect(ACTIONS_JSON.rules[0].apiPath).toBe("/api/chipin/*");
    expect(actionsJson.OPTIONS().headers.get("access-control-allow-origin")).toBe("*");
  });

  it("mainnet drops the test-money note", () => {
    expect(chipInGet({ origin: "https://x.test", estate: estate.toBase58(), cluster: "mainnet-beta" }).description).not.toMatch(/devnet/);
    expect(chipInGet({ origin: "https://x.test", estate: estate.toBase58(), cluster: "devnet" }).description).toMatch(/devnet/);
  });
});

describe("finding chip-ins by the estate's tag", () => {
  const tx = (o: { ok?: boolean; tag?: boolean; pre?: string; post?: string; mint?: string; vaultKey?: PublicKey }) => {
    const tag = new PublicKey(chipInTag(estate.toBase58()));
    const keys = [payer, k(), o.vaultKey ?? vault, ...(o.tag === false ? [] : [tag])];
    const bal = (amount: string) => [{ accountIndex: 2, mint: o.mint ?? h.mint, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } }];
    return {
      blockTime: 1_700_000_000, slot: 1,
      meta: { err: o.ok === false ? { InstructionError: [0, "x"] } : null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: bal(o.pre ?? "0"), postTokenBalances: bal(o.post ?? "5000000") },
      transaction: { signatures: ["s"], message: { accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: false })), instructions: [], recentBlockhash: "x" } },
    };
  };
  it("counts only successful transactions that raised the vault's USD₮ balance, by how much it rose", async () => {
    const txs: Record<string, unknown> = {
      good: tx({ pre: "1000000", post: "6000000" }),
      failed: tx({ ok: false }),
      out: tx({ pre: "6000000", post: "1000000" }),
      otherMint: tx({ mint: k().toBase58() }),
      notVault: tx({ vaultKey: k() }),
      untagged: tx({ tag: false }),
    };
    const conn = {
      getSignaturesForAddress: async (addr: PublicKey) => {
        expect(addr.toBase58()).toBe(chipInTag(estate.toBase58()));
        return [...Object.keys(txs).map((signature) => ({ signature, err: null, blockTime: 1, slot: 1, memo: null })), { signature: "errored", err: {}, blockTime: 1, slot: 1, memo: null }];
      },
      getParsedTransaction: async (sig: string) => (txs[sig] ?? null) as never,
    };
    const found = await findChipIns(conn as never, estate.toBase58(), h.mint);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ signature: "good", amount: 5_000_000n, from: payer.toBase58(), ts: 1_700_000_000 });
    expect(found[0].simulated).toBeUndefined();
  });
});

describe("the QR code", () => {
  it("draws dark modules only, inside a 4-module quiet zone", () => {
    const m = { size: 2, get: (r: number, c: number) => r === c };
    expect(qrPath(m)).toEqual({ path: "M4 4h1v1h-1zM5 5h1v1h-1z", viewBox: "0 0 10 10" });
  });
  it("encodes a real chip-in link", async () => {
    const q = await import("qrcode");
    const url = solanaPayUrl(chipInApiUrl("https://heirloom.test", estate.toBase58(), { amount: 50, reference: payer.toBase58() }));
    const { modules } = q.create(url, { errorCorrectionLevel: "M" });
    expect(modules.size).toBeGreaterThan(20);
    expect(qrPath(modules).path.length).toBeGreaterThan(100);
  });
});

describe("the demo simulates a chip-in, marked simulated", () => {
  const thabo = () => DEMO_PERSONAS.find((p) => p.key === "thabo")!;
  it("adds to the vault and lists it newest first; same refusals as the route", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const me = thabo();
    svc.setActor({ address: me.address, role: me.role, label: me.label });
    const [{ estate: e }] = await svc.listEstatesFor(me.address);
    const before = (await svc.getEstate(e)).estate.vaultBalance;
    expect(await svc.listChipIns(e)).toEqual([]);
    const one = await svc.simulateChipIn(50);
    await svc.simulateChipIn("12,50");
    expect(one).toMatchObject({ amount: 50_000_000n, simulated: true });
    expect(isAddress(one.from)).toBe(true);
    expect((await svc.getEstate(e)).estate.vaultBalance).toBe(before + 62_500_000n);
    const list = await svc.listChipIns(e);
    expect(list.map((x) => x.amount)).toEqual([12_500_000n, 50_000_000n]);
    expect(list.every((x) => x.simulated)).toBe(true);
    await expect(svc.simulateChipIn(0)).rejects.toThrow(/above zero/);
    await expect(svc.simulateChipIn(10_001)).rejects.toThrow(/at most/);
    await expect(svc.simulateChipIn("1.000")).rejects.toThrow(/not clear/);
    svc.simulatePassing();
    await expect(svc.simulateChipIn(5)).rejects.toThrow(/not taking chip-ins/);
    svc.resetDemo("funded");
    expect(await svc.listChipIns(e)).toEqual([]);
  });
});
