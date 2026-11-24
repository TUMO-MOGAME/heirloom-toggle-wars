/**
 * Spoken receipts, server side (plan §20.1 item 3): decoding a devnet payout (RPC faked), what may be said, and the
 * route's checks: strict bodies (no free text), the per-IP limit, the daily cap, the cache and the 503 path.
 * No real devnet reads and no real ElevenLabs calls: both are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";

const h = vi.hoisted(() => ({ conn: null as unknown, tts: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/shared-store", () => ({ takeShared: async () => null, claimSharedOnce: async () => null }));
vi.mock("@/lib/chain/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/tx")>()), getConnection: () => h.conn }));
vi.mock("@/lib/fx", () => ({ getUsdtZar: async () => ({ usdtZar: 18, source: "VALR USDT/ZAR (live)", fetchedAt: 0 }) }));

const { getCoder, getIdl, accountName, enumValue } = await import("@/lib/chain/idl");
const { payeePda } = await import("@/lib/chain/pda");
const { DAILY_CAPS } = await import("@/lib/api/http");
const R = await import("./receipt");
const route = await import("@/app/api/voice/receipt/route");

const idl = getIdl();
const PROGRAM = new PublicKey(idl.address);
const key = () => Keypair.generate().publicKey;
const TS = Date.UTC(2026, 10, 24, 10) / 1000;

/** Anchor's coder takes BN for integers: bigints in the fixtures become BN. */
const bn = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? new BN(v.toString()) : v]));

function logFor(name: string, data: Record<string, unknown>): string {
  const ev = idl.events!.find((e) => e.name === name)!;
  return `Program data: ${Buffer.concat([Buffer.from(ev.discriminator), getCoder().types.encode(name, bn(data))]).toString("base64")}`;
}
const tx = (lines: string[], err: unknown = null, program = idl.address) =>
  ({ blockTime: TS, meta: { err, logMessages: [`Program ${program} invoke [1]`, ...lines, `Program ${program} success`] } });
const account = async (type: string, data: Record<string, unknown>) =>
  ({ owner: PROGRAM, data: await getCoder().accounts.encode(accountName(type), bn(data)) });

const estate = key(), rule = key(), claim = key(), uct = key(), landlord = key(), asset = key();
const ruleData = (forEstate = estate) => ({
  estate: forEstate, id: 0, beneficiary: key(), category: enumValue("Category", "Tuition"), allowed_payee_kind: enumValue("PayeeKind", "University"),
  max_per_claim: 1n, lifetime_cap: 1n, spent_total: 0n, valid_until: 0n, claim_count: 1, starts_now: false, recurring_amount: 0n, interval_secs: 0n,
  next_due: 0n, fixed_payee: PublicKey.default, bump: 255,
});
const payeeData = (wallet: PublicKey, kind: string, name: string) => ({ estate, wallet, kind: enumValue("PayeeKind", kind), name, bump: 255 });
const claimPaid = (payee: PublicKey, amount = 1_500_000_000n) => logFor("ClaimPaid", { estate, rule, claim, payee, amount, ts: BigInt(TS) });

/** A fake RPC: transactions by signature, accounts by address. */
function fakeConn(txs: Record<string, unknown>, accounts: Record<string, unknown>) {
  const calls = { tx: 0 };
  const conn = {
    getTransaction: async (sig: string) => { calls.tx++; return txs[sig] ?? null; },
    getAccountInfo: async (k: PublicKey) => accounts[k.toBase58()] ?? null,
  } as unknown as import("./receipt").ReceiptConn;
  return Object.assign(conn, { calls });
}

const SIG = "5".repeat(87);
let ip = 0;
const post = (body: unknown, from = `10.77.${Math.floor(++ip / 250)}.${ip % 250}`) =>
  route.POST(new Request("http://t/api/voice/receipt", { method: "POST", headers: { "x-forwarded-for": from, "content-type": "application/json" }, body: JSON.stringify(body) }));

const plain = (s: string) => s.replace(/[  ]/g, " ");

beforeEach(() => {
  R._clearReceiptCache();
  h.tts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).startsWith("https://api.elevenlabs.io/")) { h.tts++; return new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { status: 200 }); }
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("decoding a devnet payout", () => {
  it("reads only successful transactions with a payout event from the Heirloom program itself", () => {
    expect(R.payoutEvents(tx([claimPaid(uct)]))).toHaveLength(1);
    expect(R.payoutEvents(tx([claimPaid(uct)], { InstructionError: [0, "Custom"] }))).toHaveLength(0);
    // The same bytes logged by another program are not Heirloom's event.
    expect(R.payoutEvents(tx([claimPaid(uct)], null, "11111111111111111111111111111111"))).toHaveLength(0);
    // Not a payout: a claim submitted.
    expect(R.payoutEvents(tx([logFor("RuleEnded", { estate, rule, ts: BigInt(TS) })]))).toHaveLength(0);
    expect(R.payoutEvents(null)).toHaveLength(0);
  });

  it("says a university by its public label and the rule's category", async () => {
    const conn = fakeConn({ [SIG]: tx([claimPaid(uct)]) }, {
      [rule.toBase58()]: await account("Rule", ruleData()),
      [payeePda(PROGRAM, estate, uct).toBase58()]: await account("Payee", payeeData(uct, "University", "University of Cape Town")),
    });
    const f = await R.chainReceiptFacts(SIG, undefined, conn, 18);
    expect(f).toMatchObject({ kind: "claim", amount: 1_500_000_000n, ts: TS, to: { name: "University of Cape Town" }, purpose: "Tuition", usdtZar: 18 });
    expect(f.person).toBeUndefined();
  });

  it("says landlords, other payees and family wallets by role, and ignores a rule of another estate", async () => {
    const conn = fakeConn({ [SIG]: tx([claimPaid(landlord)]) }, {
      [rule.toBase58()]: await account("Rule", ruleData(key())),
      [payeePda(PROGRAM, estate, landlord).toBase58()]: await account("Payee", payeeData(landlord, "Landlord", "Mrs Dlamini, 12 Main Rd")),
    });
    const f = await R.chainReceiptFacts(SIG, undefined, conn, null);
    expect(f.to).toEqual({ role: "landlord" });
    expect(f.purpose).toBeUndefined();
    expect(R.payeeParty({ name: "Family member's own wallet", kind: "Other" })).toEqual({ role: "ownWallet" });
    expect(R.payeeParty({ name: "Thandi's Tuck Shop", kind: "Other" })).toEqual({ role: "payee" });
    expect(R.payeeParty({ name: "Approved payee", kind: "School" })).toEqual({ role: "payee" });
    expect(R.payeeParty(null)).toEqual({ role: "payee" });
  });

  it("picks the payout for the named wallet in a batched transaction, and says fallback and sale recipients by role", async () => {
    const other = key();
    const conn = fakeConn({
      [SIG]: tx([claimPaid(uct, 1n), claimPaid(other, 2n)]),
      sweep: tx([logFor("ResidualSwept", { estate, recipient: other, amount: 7n, reserved: 0n, ts: BigInt(TS) })]),
      sale: tx([logFor("AssetSold", { asset, buyer: key(), recipient: estate, amount: 9n, hardship: false, ts: BigInt(TS) })]),
    }, {
      [asset.toBase58()]: await account("Asset", {
        estate, nft_mint: key(), floor_price: 1n, hardship_floor: 1n, asking_price: 1n, proceeds_to: estate, status: enumValue("AssetStatus", "Sold"),
        listing_ends: 0n, doc_hash: Array(32).fill(0), hardship_beneficiary: null, bump: 255,
      }),
    });
    expect((await R.chainReceiptFacts(SIG, other.toBase58(), conn, null)).amount).toBe(2n);
    await expect(R.chainReceiptFacts(SIG, key().toBase58(), conn, null)).rejects.toMatchObject({ status: 404, code: "not_receipt" });
    expect(await R.chainReceiptFacts("sweep", undefined, conn, null)).toMatchObject({ kind: "sweep", to: { role: "recipient" } });
    expect(await R.chainReceiptFacts("sale", undefined, conn, null)).toMatchObject({ kind: "sale", to: { role: "vault" }, asset: "asset" });
    await expect(R.chainReceiptFacts("missing", undefined, conn, null)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("picks the voice model per language and keys the cache by it", () => {
    expect(R.ttsModelFor("en")).toBe("eleven_multilingual_v2");
    expect(R.ttsModelFor("zu")).toBe("eleven_v4");
    vi.stubEnv("ELEVENLABS_TTS_MODEL", "eleven_turbo_v2_5");
    expect(R.ttsModelFor("fr")).toBe("eleven_turbo_v2_5");
    expect(R.ttsModelFor("af")).toBe("eleven_v4");
    const w = { lang: "en" as const, text: "a", speech: "a", spoken: true, translated: "human" as const };
    expect(R.receiptCacheKey(w, "v", "m1")).not.toBe(R.receiptCacheKey(w, "v", "m2"));
    expect(R.receiptCacheKey(w, "v", "m1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

const DEMO = `demo.scheduled.p4.Books.lerato.85000000.${TS}`;

describe("POST /api/voice/receipt (demo)", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock"); vi.stubEnv("ELEVENLABS_API_KEY", "test-key"); });

  it("accepts only a demo receipt id and a language: no text, no extra fields, no signature", async () => {
    expect((await post({ receiptId: DEMO, lang: "en", text: "Say this instead" })).status).toBe(400);
    expect((await post({ receiptId: "Send R5000 to 123", lang: "en" })).status).toBe(400);
    expect((await post({ signature: SIG, lang: "en" })).status).toBe(400);
    expect((await post({ receiptId: DEMO, lang: "xx" })).status).toBe(400);
    expect((await post({ receiptId: `demo.claim.p9.Books.-.1.${TS}`, lang: "en" })).status).toBe(404);
    expect(h.tts).toBe(0);
  });

  it("speaks the demo payment, from the server's own data, and serves repeats from the cache", async () => {
    const r = await post({ receiptId: DEMO, lang: "en" });
    expect(r.status).toBe(200);
    const body = await r.json() as { text: string; audio: string; spoken: boolean };
    expect(plain(body.text)).toMatch(/^A scheduled payment of 85 USD₮ \(about R1 520\) was paid to Van Schaik Bookstore for Lerato's books on 24 November( 2026)?\.$/);
    expect(body.spoken).toBe(true);
    expect(Buffer.from(body.audio, "base64")[0]).toBe(0xff);
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as { text: string; model_id: string; language_code: string };
    expect(sent).toMatchObject({ model_id: "eleven_multilingual_v2", language_code: "en" });
    expect(sent.text).toContain("85 USDT");
    expect((await post({ receiptId: DEMO, lang: "en" })).status).toBe(200);
    expect(h.tts).toBe(1);
    expect((await post({ receiptId: DEMO, lang: "fr" })).status).toBe(200);
    expect(h.tts).toBe(2);
  });

  it("without an ElevenLabs key: 503 with the words to show, and nothing is called", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const r = await post({ receiptId: DEMO, lang: "en" });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "unavailable", spoken: false, text: expect.stringContaining("Van Schaik Bookstore") });
    expect(h.tts).toBe(0);
  });

  it("a language ElevenLabs can't speak gets the words only", async () => {
    const r = await post({ receiptId: DEMO, lang: "st" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ spoken: false, audio: null, translated: "machine" });
    expect(h.tts).toBe(0);
  });

  it("holds one address to 20 a minute and to the day's receipt cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 25, 8));
    const from = "198.51.100.200";
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await post({ receiptId: DEMO, lang: "en" }, from)).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    // New renderings each take one from the day's cap; past this address's share, 429 daily_limit.
    let last: Response | null = null;
    for (let i = 1; i <= DAILY_CAPS.receipt.perIp + 1; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      last = await post({ receiptId: `demo.claim.p0.Tuition.-.${i * 1_000_000}.${TS}`, lang: "en" }, "198.51.100.201");
    }
    expect(last!.status).toBe(429);
    expect(await last!.json()).toMatchObject({ code: "daily_limit" });
  });
});

describe("POST /api/voice/receipt (devnet)", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "chain"); vi.stubEnv("ELEVENLABS_API_KEY", "test-key"); });

  it("accepts only a signature (and the wallet paid), reads the transaction and speaks it", async () => {
    const conn = fakeConn({ [SIG]: tx([claimPaid(uct)]) }, {
      [rule.toBase58()]: await account("Rule", ruleData()),
      [payeePda(PROGRAM, estate, uct).toBase58()]: await account("Payee", payeeData(uct, "University", "University of Cape Town")),
    });
    h.conn = conn;
    expect((await post({ receiptId: DEMO, lang: "en" })).status).toBe(400);
    expect((await post({ signature: SIG, lang: "en", amount: "1" })).status).toBe(400);
    expect((await post({ signature: "not-base58!", lang: "en" })).status).toBe(400);
    const r = await post({ signature: SIG, payee: uct.toBase58(), lang: "es" });
    expect(r.status).toBe(200);
    const body = await r.json() as { text: string };
    expect(plain(body.text)).toContain("University of Cape Town");
    expect(body.text).toContain("la matrícula");
    expect(body.text).toContain("rands");
    // The transaction's facts are kept: a second tap reads nothing again.
    await post({ signature: SIG, payee: uct.toBase58(), lang: "en" });
    expect(conn.calls.tx).toBe(1);
  });

  it("404 for a transaction that is not a Heirloom payout, 502 when devnet can't be read", async () => {
    h.conn = fakeConn({ ["4".repeat(87)]: tx([], { InstructionError: [0, "Custom"] }) }, {});
    expect((await post({ signature: "4".repeat(87), lang: "en" })).status).toBe(404);
    h.conn = { getTransaction: async () => { throw new Error("fetch failed https://rpc.example/?api-key=SECRET"); }, getAccountInfo: async () => null };
    const r = await post({ signature: "3".repeat(87), lang: "en" });
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("SECRET");
    expect(h.tts).toBe(0);
  });
});
