/**
 * Plan §18.9 H4: an account with the right discriminator but another owner is not this program's. Real reads
 * (lib/chain/reads.ts) over a fake RPC that holds both the real accounts and forged copies; nothing about the
 * ownership check is mocked. Real ed25519 signatures through the real routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  accounts: new Map<string, { owner: unknown; data: Buffer; lamports: number; executable: boolean }>(),
  spent: [] as string[],
  reviews: 0,
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
  agent: "261pQudaK5J4v1WCtcGjWidWU9ww3KyYC4TiU8jDsjNg",
}));

// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("@/lib/server/program", () => ({ assertProgram: async () => undefined, programProblem: async () => null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => true, rateLimit: () => undefined, rateLimitShared: async () => undefined }));
vi.mock("@/lib/chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint, cluster: "devnet" } };
});
vi.mock("@/lib/chain/tx", async (original: () => Promise<object>) => ({
  ...(await original()),
  getConnection: () => ({
    getAccountInfo: async (k: PublicKey) => h.accounts.get(k.toBase58()) ?? null,
    getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map((k) => h.accounts.get(k.toBase58()) ?? null),
  }),
}));
vi.mock("@/lib/agent/agent-wallet", () => ({
  hasAgentWallet: () => true, agentAddress: async () => h.agent,
  agentSignAndSend: async () => ({ signature: "sig", explorerUrl: "url" }),
}));
vi.mock("@/lib/agent/budget", () => ({ spendAgentAllowance: async (_a: string, _w: string, estate: string) => { h.spent.push(estate); } }));
vi.mock("@/lib/agent/review", () => ({
  reviewDocument: async () => { h.reviews++; return { verdict: "approve", reportHash: "11".repeat(32), documentType: "x", extracted: {}, redFlags: [], confidence: 1, summary: "" }; },
}));
vi.mock("@/lib/db", () => ({
  recordEvidence: async () => undefined, saveReport: async () => true, getEstateMeta: async () => null, trustedNames: () => ({}),
}));
vi.mock("@/lib/storage", async (original: () => Promise<object>) => ({
  ...(await original()),
  storeEvidence: async (bytes: Uint8Array) => ({ path: "p", sha256: "", mime: "application/pdf", size: bytes.length, backend: "none" }),
}));

const { getCoder, getIdl } = await import("./idl");
const { estatePda, beneficiaryPda } = await import("./pda");
const { fetchAccountRaw, fetchEstateRaw, findEstateOf } = await import("./reads");
const { isMember } = await import("../access/server");
const { actionHeaders } = await import("../access/client");
const { actionBody } = await import("../access/messages");
const { sha256Hex } = await import("../agent/hash");
const { askRoutes } = await import("../ask/server/route");
const { askMessage, noteBody } = await import("../ask/auth-message");
const review = await import("@/app/api/review/route");

const programId = new PublicKey(getIdl().address);
const OTHER_PROGRAM = Keypair.generate().publicKey;
const k = () => Keypair.generate().publicKey;
const bn = (n: number) => new BN(String(n));

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  return { address, signMessage: async (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}

const pdf = new TextEncoder().encode("%PDF-1.4 evidence");
let sha = "";

async function put(address: PublicKey, type: string, value: Record<string, unknown>, owner: PublicKey = programId) {
  h.accounts.set(address.toBase58(), { owner, data: await getCoder().accounts.encode(type, value), lamports: 1, executable: false });
}

const estateValue = (owner: PublicKey, verifiers = [k(), k(), k()]) => ({
  owner, agent: new PublicKey(h.agent), usdt_mint: new PublicKey(h.mint), verifiers, death_threshold: 2, claim_threshold: 1,
  hardship_threshold: 2, waiting_period_secs: bn(120), status: { Active: {} }, will_hash: Array(32).fill(0), will_uri: "",
  death_cert_hash: Array(32).fill(0), death_submitted_by: PublicKey.default, death_verdict: { Pending: {} }, death_attestations: 0,
  death_pending_since: bn(0), last_heartbeat: bn(0), rule_count: 1, bump: 255,
});
const claimValue = (estate: PublicKey, beneficiary: PublicKey) => ({
  estate, rule: k(), id: 0, beneficiary, payee: k(), amount: bn(5_000_000), evidence_hash: Array.from(Buffer.from(sha, "hex")),
  agent_verdict: { Pending: {} }, agent_report_hash: Array(32).fill(0), approvals: 0, status: { Open: {} }, created_at: bn(1), owner_approved: false, bump: 1,
});

let owner: ReturnType<typeof wallet>, stranger: ReturnType<typeof wallet>;
let estate: PublicKey;

beforeEach(async () => {
  h.accounts.clear();
  h.spent = [];
  h.reviews = 0;
  sha = await sha256Hex(pdf);
  [owner, stranger] = [wallet(), wallet()];
  estate = estatePda(programId, owner.address);
  await put(estate, "Estate", estateValue(new PublicKey(owner.address)));
});

describe("reads trust only this program's accounts", () => {
  it("a forged estate under another program is not an estate", async () => {
    const forged = estatePda(programId, stranger.address);
    await put(forged, "Estate", estateValue(new PublicKey(stranger.address)), OTHER_PROGRAM);
    expect(await fetchAccountRaw("Estate", forged.toBase58())).toBeNull();
    expect(await findEstateOf(stranger.address)).toBeNull();
    await expect(fetchEstateRaw(forged.toBase58())).rejects.toThrow(/No Heirloom estate/);
    expect(await fetchAccountRaw("Estate", estate.toBase58())).not.toBeNull();
  });

  it("lamports sent to an estate's address don't make an estate", async () => {
    const empty = estatePda(programId, stranger.address);
    h.accounts.set(empty.toBase58(), { owner: PublicKey.default, data: Buffer.alloc(0), lamports: 5_000, executable: false });
    expect(await findEstateOf(stranger.address)).toBeNull();
  });

  it("another type of this program's account is not the one asked for", async () => {
    expect(await fetchAccountRaw("Claim", estate.toBase58())).toBeNull();
  });

  it("a forged Beneficiary makes nobody a member", async () => {
    await put(beneficiaryPda(programId, estate, stranger.address), "Beneficiary",
      { estate, wallet: new PublicKey(stranger.address), label: "x", active: true, bump: 1 }, OTHER_PROGRAM);
    expect(await isMember(estate.toBase58(), stranger.address)).toBe(false);
    await put(beneficiaryPda(programId, estate, stranger.address), "Beneficiary",
      { estate, wallet: new PublicKey(stranger.address), label: "x", active: true, bump: 1 });
    expect(await isMember(estate.toBase58(), stranger.address)).toBe(true);
  });
});

describe("a forged claim through the routes", () => {
  async function askReview(claim: PublicKey) {
    const form = new FormData();
    form.set("file", new File([pdf], "e.pdf", { type: "application/pdf" }));
    form.set("purpose", "claim");
    form.set("estate", estate.toBase58());
    form.set("subject", claim.toBase58());
    const headers = await actionHeaders(stranger, "review", estate.toBase58(), actionBody.review({ purpose: "claim", subject: claim.toBase58(), sha256: sha }));
    return review.POST(new Request("http://t/api/review", { method: "POST", body: form, headers }));
  }

  it("never reaches the model and charges the family's allowance nothing", async () => {
    const claim = k();
    await put(claim, "Claim", claimValue(estate, new PublicKey(stranger.address)), OTHER_PROGRAM);
    expect((await askReview(claim)).status).toBe(404);
    expect([h.reviews, h.spent]).toEqual([0, []]);
  });

  it("the same claim written by the program is reviewed and charged", async () => {
    const claim = k();
    await put(claim, "Claim", claimValue(estate, new PublicKey(stranger.address)));
    expect((await askReview(claim)).status).toBe(200);
    expect([h.reviews, h.spent]).toEqual([1, [estate.toBase58()]]);
  });

  it("writes nothing into the family's /api/asks", async () => {
    const claim = k();
    await put(claim, "Claim", claimValue(estate, new PublicKey(stranger.address)), OTHER_PROGRAM);
    const routes = askRoutes();
    const ts = Date.now();
    const note = { purpose: "Pay me", currency: "USDT", typed: 5, attachment: false };
    const sig = await stranger.signMessage(askMessage("note", estate.toBase58(), claim.toBase58(), stranger.address, ts, sha256HexSync(noteBody(note))));
    const res = await routes.POST(new Request("http://t/api/asks", {
      method: "POST", body: JSON.stringify({ action: "note", estate: estate.toBase58(), claim: claim.toBase58(), wallet: stranger.address, ts, sig, ...note }),
    }));
    expect(res.status).toBe(404);
  });
});

const sha256HexSync = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
