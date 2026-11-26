/**
 * The chain service itself, with a fake RPC and wallet: what it signs for the second review's contract. Instructions
 * are read back from the bytes the wallet was asked to sign.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  me: "",
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
  accounts: new Map<string, unknown>(),
  scanned: [] as { type: string; raw: Record<string, unknown> }[],
  estate: null as unknown,
  signed: [] as unknown[],
  status: "confirmed",
  posts: [] as string[],
  existing: new Set<string>(),
}));

// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("../chain/write-guard", () => ({ requireCurrentApp: async () => undefined }));
vi.mock("../chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint } };
});
vi.mock("../chain/client", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const { getIdl } = await import("../chain/idl");
  return { chainCtx: () => ({ programId: new PublicKey(getIdl().address), usdtMint: new PublicKey(h.mint) }) };
});
vi.mock("../wallet/signer", () => {
  const signer = () => ({ address: h.me, signMessage: async () => "00".repeat(64), canSignQuietly: () => true });
  return { getActiveSigner: signer, peekActiveSigner: signer };
});
vi.mock("../wallet/store", () => ({ loadWallets: () => [] }));
vi.mock("../wallet/payments", async (original: () => Promise<object>) => ({
  ...(await original()),
  signSponsoredOrSelf: async (d: { user: string; build(feePayer: string): Promise<{ base64: string }> }) => {
    h.signed.push((await d.build(d.user)).base64);
    return {};
  },
  runPayment: async (_s: unknown, _o: unknown, _id: string, sign: () => Promise<unknown>) => {
    await sign();
    return { status: "submitted", signature: "sig" };
  },
  waitForFinal: async () => ({ status: h.status, signature: "sig" }),
}));
vi.mock("../chain/tx", async (original: () => Promise<object>) => ({
  ...(await original()),
  getConnection: () => ({
    getLatestBlockhash: async () => ({ blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1 }),
    getAccountInfo: async (address: { toBase58(): string }) => (h.existing.has(address.toBase58()) ? { owner: null, data: new Uint8Array(0) } : null),
    getBalance: async () => 0,
    getMinimumBalanceForRentExemption: async (bytes: number) => (bytes + 128) * 6960,
  }),
}));
vi.mock("../chain/reads", async (original: () => Promise<object>) => ({
  ...(await original()),
  fetchAccountRaw: async (_type: string, address: string) => h.accounts.get(address) ?? null,
  fetchEstateRaw: async () => h.estate,
  findEstateOf: async () => null,
  invalidateProgramAccounts: () => undefined,
  scanAccounts: async (type: string) => h.scanned.filter((s) => s.type === type).map((s) => ({ data: new Uint8Array(400).fill(0), raw: s.raw })),
  decodeScanned: (_type: string, a: { raw: Record<string, unknown> }) => a.raw,
}));

const { getCoder, getIdl } = await import("../chain/idl");
const { beneficiaryPda, estatePda, guardPda, objectionPda, offerPda, payeePda, rulePda } = await import("../chain/pda");
const { sha256Hex } = await import("../agent/hash");
const { createChainService } = await import("./chain");

const programId = new PublicKey(getIdl().address);
const key = () => Keypair.generate().publicKey.toBase58();
const [owner, agent, kid, res, v1, v2, v3] = Array.from({ length: 7 }, key);
const estate = estatePda(programId, owner).toBase58();
const NOBODY = PublicKey.default.toBase58();
const ixs = (): TransactionInstruction[] => h.signed.flatMap((b) => Transaction.from(Buffer.from(b as string, "base64")).instructions);
const names = () => ixs().map((t) => getCoder().instruction.decode(Buffer.from(t.data))!.name);
const passes = (address: PublicKey) => ixs()[0].keys.some((m) => m.pubkey.equals(address));

const draft = {
  ownerName: "Owner",
  beneficiaries: [{ label: "Child", relationship: "child", wallet: kid }],
  verifiers: [{ name: "One", role: "r", wallet: v1 }, { name: "Two", role: "r", wallet: v2 }, { name: "Three", role: "r", wallet: v3 }],
  rules: [{
    beneficiaryLabel: "Child", category: "Accommodation" as const, allowedPayeeKind: "Landlord" as const, maxPerClaimUsdt: 300,
    lifetimeCapUsdt: 9_000, validUntil: "2099-12-31", notes: "", startsNow: true,
    recurring: { amountUsdt: 300, every: "month" as const, payeeName: "Campus Residence" },
  }],
  assets: [], waitingPeriodDays: 30, plainLanguageSummary: "",
};

beforeEach(() => {
  h.me = owner;
  h.accounts.clear();
  Object.assign(h, { signed: [], status: "confirmed", posts: [], scanned: [], estate: null, existing: new Set<string>() });
  vi.stubGlobal("fetch", async (url: string) => {
    h.posts.push(String(url));
    const body = String(url) === "/api/agent" ? { agentAddress: agent }
      : String(url) === "/api/review" ? { report: { verdict: "approve" }, tx: { signature: "review", explorerUrl: "" }, onChain: "" }
        : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

describe("U1: I'm still here", () => {
  it("is the heartbeat, which cancels a death claim, and a success only once confirmed", async () => {
    expect((await createChainService().heartbeat(estate)).signature).toBe("sig");
    expect(names()).toEqual(["heartbeat"]);
    expect(ixs()[0].keys.map((m) => [m.pubkey.toBase58(), m.isWritable]).find(([k]) => k === estate)).toEqual([estate, true]);
  });

  it("P2: a withdrawal writes the estate too, so the program records it as proof of life", async () => {
    await createChainService().withdraw(estate, 1);
    expect(names()).toEqual(["withdraw"]);
    expect(ixs()[0].keys.map((m) => [m.pubkey.toBase58(), m.isWritable]).find(([k]) => k === estate)).toEqual([estate, true]);
  });

  it.each(["pending", "submitted"])("%s: no success is reported", async (status) => {
    h.status = status;
    await expect(createChainService().heartbeat(estate)).rejects.toThrow(/^NotConfirmed: /);
  });

  it("H8: signed and sent is 'still checking' on its payment id, never a failure", async () => {
    h.status = "submitted";
    await expect(createChainService().heartbeat(estate)).rejects.toMatchObject({ code: "NotConfirmed", signature: "sig", paymentId: expect.stringMatching(/^pay_/) });
  });
});

describe("createEstateFromWill", () => {
  it("U2: a schedule without its payee signs nothing: code recurring_payee", async () => {
    await expect(createChainService().createEstateFromWill(draft)).rejects.toMatchObject({ code: "recurring_payee" });
    expect(h.signed).toEqual([]);
  });

  it.each([
    ["a duplicate trusted person", [draft.verifiers[0], draft.verifiers[1], { ...draft.verifiers[2], wallet: v1 }], "DuplicateVerifier"],
    ["the agent as a trusted person", [draft.verifiers[0], draft.verifiers[1], { ...draft.verifiers[2], wallet: agent }], "BadAgent"],
    ["two trusted people", draft.verifiers.slice(0, 2), "DuplicateVerifier"],
  ])("%s signs nothing", async (_, verifiers, code) => {
    await expect(createChainService().createEstateFromWill({ ...draft, verifiers }, { practice: true })).rejects.toMatchObject({ code });
    expect(h.signed).toEqual([]);
  });

  it("P1: a new estate is signed with two trusted people for a passing and at least 5 minutes' wait", async () => {
    await createChainService().createEstateFromWill({ ...draft, waitingPeriodDays: 0 }, { practice: true });
    const create = getCoder().instruction.decode(Buffer.from(ixs()[0].data))!.data as { death_threshold: number; waiting_period_secs: unknown };
    expect([create.death_threshold, Number(String(create.waiting_period_secs)) >= 300]).toEqual([2, true]);
  });

  it("practice mode makes the payee and writes the schedule", async () => {
    await createChainService().createEstateFromWill(draft, { practice: true });
    expect(names()).toEqual(["create_estate", "set_will", "add_beneficiary", "add_payee", "add_rule_v2", "set_residual"]);
    const rule = getCoder().instruction.decode(Buffer.from(ixs()[4].data))!.data as { recurring_amount: unknown; rule_id: number };
    expect([rule.rule_id, String(rule.recurring_amount)]).toEqual([0, "300000000"]);
  });
});

describe("payouts pass the accounts they re-check (R16)", () => {
  it("executeClaim: the claim's beneficiary and payee", async () => {
    const claim = key();
    h.accounts.set(claim, { rule: rulePda(programId, estate, 0), beneficiary: kid, payee: res, amount: 5 });
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200 })); // the request notes: no "no"
    await createChainService().executeClaim(estate, claim);
    expect([passes(beneficiaryPda(programId, estate, kid)), passes(payeePda(programId, estate, res))]).toEqual([true, true]);
  });

  it("executeScheduled: a rule that now pays something else than was shown signs nothing", async () => {
    const rule = rulePda(programId, estate, 0).toBase58();
    h.accounts.set(rule, { beneficiary: kid, fixed_payee: res, recurring_amount: 5 });
    await expect(createChainService().executeScheduled(estate, rule, { amount: 6n, payee: res })).rejects.toMatchObject({ code: "ScheduleChanged" });
    expect(h.signed).toEqual([]);
  });

  it("executeScheduled: the rule's", async () => {
    const rule = rulePda(programId, estate, 0).toBase58();
    h.accounts.set(rule, { beneficiary: kid, fixed_payee: res, recurring_amount: 5 });
    await createChainService().executeScheduled(estate, rule);
    expect([passes(beneficiaryPda(programId, estate, kid)), passes(payeePda(programId, estate, res))]).toEqual([true, true]);
  });
});

describe("submitDeathClaim", () => {
  const cert = () => new File(["%PDF-1.4 certificate"], "c.pdf", { type: "application/pdf" });
  // A reviewed claim gives way once stale; an unreviewed one never does (only the review is asked again).
  const standing = (by: string, hash: number[], since: number, verdict: object = { Approved: {} }) => h.accounts.set(estate, {
    status: { Active: {} }, agent, waiting_period_secs: 120, verifiers: [v1, v2, v3], death_cert_hash: hash,
    death_verdict: verdict, death_submitted_by: by, death_pending_since: since, last_heartbeat: 0,
  });
  const nowSecs = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    h.me = kid;
    h.accounts.set(beneficiaryPda(programId, estate, kid).toBase58(), { wallet: kid, active: true });
  });
  const account = (name: string) => {
    const at = getIdl().instructions.find((i) => i.name === "submit_death_claim")!.accounts.findIndex((a) => a.name === name);
    return ixs()[0].keys[at].pubkey.toBase58();
  };

  it.each([
    ["an active beneficiary passes their account", () => kid, () => beneficiaryPda(programId, estate, kid).toBase58(), () => programId.toBase58()],
    ["a trusted person passes neither", () => v2, () => programId.toBase58(), () => programId.toBase58()],
    ["a living listed fallback recipient passes the Guard", () => res, () => programId.toBase58(), () => guardPda(programId, estate).toBase58()],
  ])("%s, and the claim's objection goes along", async (_, who, benAccount, guardAccount) => {
    h.me = who();
    h.accounts.set(guardPda(programId, estate).toBase58(), { fallback: [res, NOBODY, NOBODY, NOBODY], fallback_dead: 0 });
    standing(v1, Array<number>(32).fill(7), 1);
    await createChainService().submitDeathClaim(estate, cert());
    expect([account("beneficiary_account"), account("guard"), account("objection")])
      .toEqual([benAccount(), guardAccount(), objectionPda(programId, estate).toBase58()]);
  });

  it.each([
    ["the agent", () => agent], ["a stranger", () => key()], ["a fallback recipient proven dead", () => res],
  ])("%s can't: nothing is signed", async (_, who) => {
    h.me = who();
    h.accounts.set(guardPda(programId, estate).toBase58(), { fallback: [res, NOBODY, NOBODY, NOBODY], fallback_dead: 1 });
    standing(v1, Array<number>(32).fill(7), 1);
    await expect(createChainService().submitDeathClaim(estate, cert())).rejects.toMatchObject({ code: "NotParticipant" });
    expect([h.signed.length, h.posts.includes("/api/review")]).toEqual([0, false]);
  });

  it("replaces a stale claim, then asks for its review", async () => {
    standing(v1, Array<number>(32).fill(7), 1);
    expect((await createChainService().submitDeathClaim(estate, cert())).tx.signature).toBe("sig");
    expect(names()).toEqual(["submit_death_claim"]);
    expect(h.posts).toContain("/api/review");
  });

  it("a fresh one by someone else stands: nothing is sent or reviewed", async () => {
    standing(v1, Array<number>(32).fill(7), nowSecs());
    await expect(createChainService().submitDeathClaim(estate, cert())).rejects.toMatchObject({ code: "BadStatus" });
    expect([h.signed.length, h.posts.includes("/api/review")]).toEqual([0, false]);
  });

  it("your own, unreviewed: only the review again", async () => {
    standing(kid, [...Buffer.from(await sha256Hex(new Uint8Array(await cert().arrayBuffer())), "hex")], nowSecs(), { Pending: {} });
    expect((await createChainService().submitDeathClaim(estate, cert())).tx.signature).toBe("review");
    expect(h.signed).toEqual([]);
  });
});

describe("C2: a file the review would refuse signs nothing", () => {
  it.each(["submitClaim", "submitHardship", "submitDeathClaim"] as const)("%s", async (method) => {
    h.me = kid;
    const fake = new File(["Heirloom demo document: x.pdf"], "x.pdf", { type: "application/pdf" });
    const svc = createChainService();
    const work = method === "submitDeathClaim" ? svc.submitDeathClaim(estate, fake)
      : method === "submitClaim" ? svc.submitClaim(estate, { rule: key(), payee: res, amountUsdt: 5, evidence: fake })
        : svc.submitHardship(estate, { asset: key(), evidence: fake });
    await expect(work).rejects.toMatchObject({ code: "FileType" });
    expect([h.signed.length, h.posts.includes("/api/review")]).toEqual([0, false]);
  });
});

describe("H9: the owner's no stands after the death", () => {
  it("approveClaim signs nothing for a declined request, and nothing when the notes can't be read", async () => {
    const claim = key();
    h.accounts.set(claim, { rule: rulePda(programId, estate, 0), beneficiary: kid, payee: res, amount: 5, owner_approved: false });
    h.me = v1;
    const stub = (body: unknown, status = 200) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
    stub([{ claim, purpose: "trip", currency: "USDT", typed: 5, createdAt: 1, attachment: false, declinedAt: 9 }]);
    await expect(createChainService().approveClaim(estate, claim)).rejects.toMatchObject({ code: "Declined" });
    stub({ error: "down" }, 503);
    await expect(createChainService().approveClaim(estate, claim)).rejects.toMatchObject({ code: "DeclineUnknown" });
    expect(h.signed).toEqual([]);
    stub([]);
    await createChainService().approveClaim(estate, claim);
    expect(names()).toEqual(["approve_claim"]);
  });

  it("N8: executeClaim pays nothing for a declined request, nor when the notes can't be read", async () => {
    const claim = key();
    h.accounts.set(claim, { rule: rulePda(programId, estate, 0), beneficiary: kid, payee: res, amount: 5, owner_approved: false });
    h.me = v1;
    const stub = (body: unknown, status = 200) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
    stub([{ claim, purpose: "trip", currency: "USDT", typed: 5, createdAt: 1, attachment: false, declinedAt: 9 }]);
    await expect(createChainService().executeClaim(estate, claim)).rejects.toMatchObject({ code: "Declined" });
    stub({ error: "down" }, 503);
    await expect(createChainService().executeClaim(estate, claim)).rejects.toMatchObject({ code: "DeclineUnknown" });
    expect(h.signed).toEqual([]);
    stub([]);
    await createChainService().executeClaim(estate, claim);
    expect(names()).toEqual(["execute_claim"]);
  });
});

describe("H13: changing an offer", () => {
  it("withdraws the old one and places the new one in one transaction", async () => {
    h.me = res;
    const asset = key();
    h.existing.add(offerPda(programId, asset, res).toBase58());
    await createChainService().placeOffer(estate, asset, 12);
    expect(h.signed).toHaveLength(1);
    expect(names()).toEqual(["withdraw_offer", "place_offer"]);
  });
  it("a first offer only places", async () => {
    h.me = res;
    await createChainService().placeOffer(estate, key(), 12);
    expect(names()).toEqual(["place_offer"]);
  });
});

describe("H7: a review that didn't finish", () => {
  it("submitClaim says the claim was sent and waits for its review", async () => {
    h.me = kid;
    const rule = rulePda(programId, estate, 0).toBase58();
    h.accounts.set(rule, { id: 0, claim_count: 0 });
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(String(url) === "/api/review" ? { error: "busy" } : {}), { status: String(url) === "/api/review" ? 503 : 200 }));
    const file = new File(["%PDF-1.4 fees"], "f.pdf", { type: "application/pdf" });
    await expect(createChainService().submitClaim(estate, { rule, payee: res, amountUsdt: 5, evidence: file })).rejects.toMatchObject({ code: "ReviewPending" });
    expect(names()).toEqual(["submit_claim"]);
  });

  it("requestReview: only the sender, only while pending, only the same file; nothing is signed", async () => {
    const claim = key();
    const file = new File(["%PDF-1.4 fees"], "f.pdf", { type: "application/pdf" });
    const hash = [...Buffer.from(await sha256Hex(new Uint8Array(await file.arrayBuffer())), "hex")];
    h.accounts.set(claim, { beneficiary: kid, payee: res, amount: 5, agent_verdict: { Pending: {} }, evidence_hash: hash });
    h.me = kid;
    await expect(createChainService().requestReview(estate, { kind: "claim", subject: claim, evidence: new File(["%PDF-1.4 other"], "o.pdf", { type: "application/pdf" }) }))
      .rejects.toMatchObject({ code: "hash_mismatch" });
    h.me = res;
    await expect(createChainService().requestReview(estate, { kind: "claim", subject: claim, evidence: file })).rejects.toMatchObject({ code: "forbidden" });
    expect(h.posts).not.toContain("/api/review");
    h.me = kid;
    expect((await createChainService().requestReview(estate, { kind: "claim", subject: claim, evidence: file })).report).toEqual({ verdict: "approve" });
    expect([h.signed.length, h.posts.filter((p) => p === "/api/review").length]).toEqual([0, 1]);
  });
});

describe("H6: an interrupted signing is finished, and nothing is lost", () => {
  it("interrupt, reload, resume", async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    const rules = Array.from({ length: 5 }, (_, i) => ({ ...draft.rules[0], recurring: undefined, category: "Books" as const, allowedPayeeKind: "School" as const, maxPerClaimUsdt: 10 + i, lifetimeCapUsdt: 100 }));
    const plan = { ...draft, rules };
    let sends = 0;
    Object.defineProperty(h, "status", { configurable: true, get: () => (++sends === 2 ? "failed" : "confirmed"), set: () => undefined });
    await expect(createChainService().createEstateFromWill(plan, { practice: true })).rejects.toThrow();
    // The names went to the server as soon as the estate existed, not at the end.
    expect(h.posts).toContain("/api/estate-meta");
    // A reload: a new service on the same device offers to finish the same plan.
    const after = createChainService();
    const left = await after.unfinishedSigning();
    expect([left?.draft.rules.length, left?.draft.ownerName, left?.options.practice]).toEqual([5, "Owner", true]);
    await after.createEstateFromWill(plan, { practice: true });
    expect(await createChainService().unfinishedSigning()).toBeNull();
    Object.defineProperty(h, "status", { configurable: true, writable: true, value: "confirmed" });
  });
});

describe("M3: the cost is read before approval", () => {
  it("a payout to a new account, a trusted person's approval and a first offer count their rent, read from the network", async () => {
    h.me = v1;
    const svc = createChainService();
    const payout = await svc.quoteFee(estate, { kind: "claim-payout", to: res, amount: 5n, approve: "verifier", claim: key() });
    // No sponsor in this test: the user pays two network fees, the payee's token account and the approval stamp.
    expect(payout.fee.sponsored).toBe(false);
    expect(payout.userLamports).toBe(2 * 5_000 + (165 + 128) * 6960 + (82 + 128) * 6960);
    const offer = await svc.quoteFee(estate, { kind: "offer", to: key(), amount: 5n });
    expect(offer.fee.rentLamports).toBe((89 + 128) * 6960 + (165 + 128) * 6960);
    expect((await svc.quoteFee(estate, { kind: "vault-deposit", to: estate, amount: 5n })).fee.rentLamports).toBe(0);
  });
});

describe("approveHardship (R21)", () => {
  it("not while someone else's approved hardship stands", async () => {
    const [hardship, asset] = [key(), key()];
    h.accounts.set(hardship, { asset, beneficiary: kid });
    h.accounts.set(asset, { hardship_beneficiary: res });
    h.me = v1;
    await expect(createChainService().approveHardship(estate, hardship)).rejects.toMatchObject({ code: "BadStatus" });
    expect(h.signed).toEqual([]);
    h.accounts.set(asset, { hardship_beneficiary: null });
    await createChainService().approveHardship(estate, hardship);
    expect(names()).toEqual(["approve_hardship"]);
  });
});

describe("listAsset: who may ask the agent", () => {
  const none = PublicKey.default.toBase58();
  it.each([
    ["a trusted person", [v1, v2, v3], v2, true, "Held", true],
    ["a trusted person relisting", [v1, v2, v3], v2, true, "Listed", true],
    ["a beneficiary while three seats are held", [v1, v2, v3], kid, true, "Held", false],
    ["a beneficiary while one seat is held", [none, v2, none], kid, true, "Held", false],
    ["a beneficiary when no seat is held", [none, none, none], kid, true, "Held", true],
    ["a beneficiary relisting while the listing runs", [none, none, none], kid, true, "Listed", false],
    ["a beneficiary relisting after it ended with no offer", [none, none, none], kid, true, "Ended", true],
    ["a removed beneficiary when no seat is held", [none, none, none], kid, false, "Held", false],
    ["a stranger when no seat is held", [none, none, none], res, true, "Held", false],
  ])("%s", async (_, verifiers, me, active, status, allowed) => {
    h.me = me;
    const asset = key();
    h.estate = { estate: { verifiers }, beneficiaries: [{ wallet: kid, active }], assets: [{ address: asset, status: status === "Ended" ? "Listed" : status, listingEnds: status === "Ended" ? 1 : 4e9, floorPrice: 900n, hardshipFloor: 700n, hardshipBeneficiary: null }], offers: [] };
    const listed = createChainService().listAsset(estate, asset, 86_400);
    if (allowed) await listed;
    else await expect(listed).rejects.toMatchObject({ code: "NotVerifier" });
    expect(h.posts.filter((p) => p === "/api/list-asset")).toHaveLength(allowed ? 1 : 0);
  });
});

describe("estate lists", () => {
  it.each([[true, ["beneficiary"]], [false, []]])("a Beneficiary with active=%s", async (active, roles) => {
    h.me = key();
    h.scanned = [{ type: "Beneficiary", raw: { active } }];
    expect((await createChainService().listEstatesFor(h.me)).map((e) => e.role)).toEqual(roles);
  });

  it.each(["Seat", "Guard"])("a wallet named only in a %s gets the estate once, as monitor", async (type) => {
    h.me = key();
    h.scanned = [{ type, raw: {} }];
    expect((await createChainService().listEstatesFor(h.me)).map((e) => e.role)).toEqual(["monitor"]);
  });
});
