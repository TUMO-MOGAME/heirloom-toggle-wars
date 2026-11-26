/**
 * Plan §18.4 U4, R12 and R19: the agent adds its signature only to the exact sale a living trusted person signed.
 * Each way of tampering has a test. Real ed25519 signatures and real transaction bytes against the route; the chain
 * and the agent's wallet are fakes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputeBudgetProgram, Keypair, MessageV0, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
} from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";
import { sign as edSign, createPrivateKey } from "node:crypto";

const h = vi.hoisted(() => ({
  agent: "",
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
  snap: null as unknown,
  fresh: 0,
  blockhashValid: true,
  alone: [] as unknown[],
  coSigned: [] as unknown[],
  refuse: null as string | null,
  spent: 0,
  /** Accounts by address for fetchAccountRaw (the Guard, the sale's objection, a hardship's stamp). */
  raw: {} as Record<string, unknown>,
}));

// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("@/lib/server/program", () => ({ assertProgram: async () => undefined, programProblem: async () => null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => true, rateLimitShared: async () => undefined }));
vi.mock("@/lib/chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint } };
});
vi.mock("@/lib/chain/client", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const { getIdl } = await import("@/lib/chain/idl");
  return { chainCtx: () => ({ programId: new PublicKey(getIdl().address), usdtMint: new PublicKey(h.mint) }), prepareTx: async () => "" };
});
vi.mock("@/lib/chain/tx", async (original: () => Promise<object>) => ({
  ...(await original()), getConnection: () => ({ isBlockhashValid: async () => ({ value: h.blockhashValid }) }),
}));
vi.mock("@/lib/chain/reads", () => ({ invalidateProgramAccounts: () => { h.fresh++; }, fetchAccountRaw: async (_t: string, address: string) => h.raw[address] ?? null }));
vi.mock("@/lib/server/estate", () => ({ loadPublicSnapshot: async () => h.snap }));
vi.mock("@/lib/agent/budget", () => ({ spendAgentAllowance: async () => { h.spent++; }, spendAgentRent: async () => undefined }));
vi.mock("@/lib/agent/agent-wallet", async (original: () => Promise<object>) => ({
  ...(await original()),
  hasAgentWallet: () => true,
  agentAddress: async () => h.agent,
  agentSignAndSend: async (ixs: unknown[]) => { h.alone.push(...ixs); return { signature: "alone", explorerUrl: "url" }; },
  agentCoSignSale: async (tx: unknown) => {
    if (h.refuse) throw new Error(h.refuse);
    h.coSigned.push(tx);
    return { signature: "sale", explorerUrl: "url" };
  },
}));

const { getIdl, getCoder, findInstruction } = await import("@/lib/chain/idl");
const { estatePda, assetPda, offerPda, ata, hardshipPda, objectionPda, guardPda, stampPda } = await import("@/lib/chain/pda");
const ix = await import("@/lib/chain/instructions");
const { saleInstruction, saleTransaction, checkSaleTx } = await import("./sale");
const { rankOffers } = await import("./offers");
const { AGENT_ALLOWED, assertAllowed, assertOneSale } = await import("./agent-wallet");
const { actionHeaders } = await import("../access/client");
const { actionBody } = await import("../access/messages");
const settle = await import("@/app/api/accept-offer/route");

const programId = new PublicKey(getIdl().address);
const mint = new PublicKey(h.mint);
const ctx = { programId, usdtMint: mint };
const HASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const NOBODY = PublicKey.default.toBase58();
const key = () => Keypair.generate().publicKey.toBase58();
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

function person(k = Keypair.generate()) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(k.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" });
  return { k, address: k.publicKey.toBase58(), signMessage: async (m: string) => edSign(null, Buffer.from(m, "utf8"), priv).toString("hex") };
}
type Person = ReturnType<typeof person>;

let agent: Keypair;
let trusted: Person, second: Person, buyer: Person, lowBuyer: Person, child: Person, outsider: Person;
let estate: string, asset: { address: string; nftMint: string; proceedsTo: string; hardshipBeneficiary: string | null; floorPrice: bigint; hardshipFloor: bigint; status: "Listed"; listingEnds: number };
let best: { address: string; asset: string; buyer: string; amount: bigint; createdAt: number };
let low: typeof best;
let world: { estate: { agent: string; usdtMint: string; verifiers: string[] }; beneficiaries: { wallet: string; active: boolean }[]; assets: (typeof asset)[]; offers: (typeof best)[] };

beforeEach(() => {
  agent = Keypair.generate();
  [trusted, second, buyer, lowBuyer, child, outsider] = Array.from({ length: 6 }, () => person());
  estate = estatePda(programId, key()).toBase58();
  const nftMint = key();
  const address = assetPda(programId, estate, nftMint).toBase58();
  asset = { address, nftMint, proceedsTo: key(), hardshipBeneficiary: null, floorPrice: 9n, hardshipFloor: 7n, status: "Listed", listingEnds: 4_000_000_000 };
  const offer = (who: Person, amount: bigint) => ({ address: offerPda(programId, address, who.address).toBase58(), asset: address, buyer: who.address, amount, createdAt: 1 });
  [best, low] = [offer(buyer, 12n), offer(lowBuyer, 10n)];
  world = {
    estate: { agent: agent.publicKey.toBase58(), usdtMint: h.mint, verifiers: [trusted.address, second.address, key()] },
    beneficiaries: [{ wallet: child.address, active: true }], assets: [asset], offers: [low, best],
  };
  Object.assign(h, { agent: agent.publicKey.toBase58(), snap: world, fresh: 0, blockhashValid: true, alone: [], coSigned: [], refuse: null, spent: 0, raw: {} });
});

const sale = (over: Partial<Parameters<typeof saleInstruction>[1]> = {}) =>
  ({ estate, agent: agent.publicKey.toBase58(), asset, offer: best, coSigner: trusted.address as string | null, ...over });
const theSale = (over: Parameters<typeof sale>[0] = {}) => saleInstruction(ctx, sale(over));

/** The wire bytes the agent is sent. */
function wire(ixs: TransactionInstruction[] = [theSale()], o: { feePayer?: PublicKey; signers?: Keypair[] } = {}): Uint8Array {
  const tx = new Transaction({ feePayer: o.feePayer ?? agent.publicKey, recentBlockhash: HASH }).add(...ixs);
  const signers = (o.signers ?? [trusted.k]).filter((s) => tx.compileMessage().accountKeys.some((a) => a.equals(s.publicKey)));
  if (signers.length) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
const b64 = (w: Uint8Array) => Buffer.from(w).toString("base64");

/** A fresh request signature over exactly this body, so only the transaction itself is under test. */
async function send(tx: string | undefined, who: Person = trusted, headers?: Record<string, string>) {
  const body = { estate, asset: asset.address, tx };
  return settle.POST(new Request("http://t/api/accept-offer", {
    method: "POST", body: JSON.stringify(body),
    headers: headers ?? await actionHeaders(who, "accept-offer", estate, actionBody.acceptOffer(body)),
  }));
}

async function refused(res: Response, status: number, code: string) {
  expect({ status: res.status, code: ((await res.json()) as { code?: string }).code }).toEqual({ status, code });
  expect([h.coSigned.length, h.alone.length]).toEqual([0, 0]);
}

describe("the honest sale", () => {
  it("is co-signed: the best offer, read from the chain afresh, and only the co-signed path", async () => {
    const res = await send(b64(wire()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ranking: { bestOffer: string } }).ranking.bestOffer).toBe(best.address);
    expect([h.fresh, h.spent, h.alone.length, h.coSigned.length]).toEqual([1, 1, 0, 1]);
    const tx = h.coSigned[0] as Transaction;
    expect(tx.signatures.map((s) => [s.publicKey.toBase58(), !!s.signature])).toEqual([[h.agent, false], [trusted.address, true]]);
    expect(getCoder().instruction.decode(Buffer.from(tx.instructions[0].data))!.data).toMatchObject({ expected_amount: expect.anything() });
  });

  it("the same bytes as the browser builds", () => {
    const tx = saleTransaction(ctx, sale(), HASH);
    tx.partialSign(trusted.k);
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    expect(checkSaleTx(bytes, ctx, { ...sale(), coSigner: trusted.address }).instructions).toHaveLength(1);
  });

  it("an approved hardship's recipient and objection account", async () => {
    asset.hardshipBeneficiary = child.address;
    const t = theSale();
    expect(t.keys.some((k) => k.pubkey.equals(objectionPda(programId, hardshipPda(programId, asset.address, child.address))))).toBe(true);
    expect((await send(b64(wire([t])))).status).toBe(200);
  });
});

describe("P4: the hardship beneficiary never co-signs the sale that pays them (plan §22.1)", () => {
  it("as a trusted person, refused before anything is signed", async () => {
    asset.hardshipBeneficiary = trusted.address;
    await refused(await send(b64(wire([theSale()]))), 403, "CoSignerRequired");
  });

  it("holding the only seat left: the agent's lone path once the listing has ended", async () => {
    asset.hardshipBeneficiary = trusted.address;
    world.estate.verifiers = [trusted.address, PublicKey.default.toBase58(), PublicKey.default.toBase58()];
    await refused(await send(undefined), 409, "ListingStillOpen");
    asset.listingEnds = 1_000;
    expect((await send(undefined)).status).toBe(200);
    expect(h.alone).toHaveLength(1);
  });
});

describe("not the sale that stands now", () => {
  const changed = async (t: TransactionInstruction, signers?: Keypair[]) =>
    refused(await send(b64(wire([t], signers ? { signers } : {}))), 409, "sale_changed");

  it("a lower amount than the offer (R19)", () => changed(theSale({ offer: { ...best, amount: 9n } })));
  it("a higher amount than the offer", () => changed(theSale({ offer: { ...best, amount: 13n } })));
  it("another buyer's lower offer", () => changed(theSale({ offer: low })));
  it("another recipient", () => changed(theSale({ asset: { ...asset, proceedsTo: outsider.address } })));
  it("another estate", () => changed(theSale({ estate: estatePda(programId, key()).toBase58() })));
  it("another asset", () => changed(theSale({ asset: { ...asset, address: key() } })));
  it("another title", () => changed(theSale({ asset: { ...asset, nftMint: key() } })));
  it("a hardship recipient the chain doesn't have", () => changed(theSale({ asset: { ...asset, hardshipBeneficiary: child.address } })));
  it("someone else as co-signer", () => changed(theSale({ coSigner: second.address }), [second.k]));
  it("no co-signer", () => changed(theSale({ coSigner: null })));

  const tampered = (edit: (t: TransactionInstruction) => void) => {
    const t = theSale();
    edit(t);
    return t;
  };
  it("an account swapped for the agent's own token account", () =>
    changed(tampered((t) => { t.keys[8] = { ...t.keys[8], pubkey: ata(mint, agent.publicKey) }; })));
  it("another token program", () => changed(tampered((t) => { t.keys[12] = { ...t.keys[12], pubkey: new PublicKey(key()) }; })));
  it("an account made writable", () => changed(tampered((t) => { t.keys[9] = { ...t.keys[9], isWritable: true }; })));
  it("the agent again as an extra account", () =>
    changed(tampered((t) => { t.keys.push({ pubkey: agent.publicKey, isSigner: false, isWritable: true }); })));
  it("an extra account of any kind", () =>
    changed(tampered((t) => { t.keys.push({ pubkey: ata(mint, agent.publicKey), isSigner: false, isWritable: true }); })));
  it("a third signer", () =>
    changed(tampered((t) => { t.keys.push({ pubkey: second.k.publicKey, isSigner: true, isWritable: false }); }), [trusted.k, second.k]));
  it("extra argument bytes", () => changed(tampered((t) => { t.data = Buffer.concat([t.data, Buffer.from([1])]); })));

  it("the offer was swapped for a lower one after signing (R19)", async () => {
    const signed = b64(wire());
    best.amount = 11n;
    await refused(await send(signed), 409, "sale_changed");
  });

  it("a higher offer arrived after signing", async () => {
    const signed = b64(wire());
    const late = person();
    world.offers.push({ ...best, buyer: late.address, address: offerPda(programId, asset.address, late.address).toBase58(), amount: 20n });
    await refused(await send(signed), 409, "sale_changed");
  });

  it("the signed offer was withdrawn", async () => {
    const signed = b64(wire());
    world.offers = [low];
    await refused(await send(signed), 409, "sale_changed");
  });

  it("the proceeds wallet changed under it", async () => {
    const signed = b64(wire());
    asset.hardshipBeneficiary = child.address;
    await refused(await send(signed), 409, "sale_changed");
  });

  it("a blockhash that no longer holds", async () => {
    h.blockhashValid = false;
    await refused(await send(b64(wire())), 409, "stale_sale");
    expect(h.spent).toBe(0);
  });
});

describe("not a sale at all", () => {
  const bad = async (w: Uint8Array | string) => refused(await send(typeof w === "string" ? w : b64(w)), 422, "bad_sale_tx");
  const drain = () => SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: outsider.k.publicKey, lamports: 1 });

  it("the agent's SOL sent along", () => bad(wire([theSale(), drain()])));
  it("the agent's SOL first", () => bad(wire([drain(), theSale()])));
  it("only the agent's SOL", () => bad(wire([drain()], { signers: [] })));
  it("the agent's tokens sent along", () =>
    bad(wire([theSale(), createTransferInstruction(ata(mint, agent.publicKey), ata(mint, outsider.address), agent.publicKey, 1n)])));
  it("two sales", () => bad(wire([theSale(), theSale({ offer: low })])));
  it("a priority fee the agent would pay", () => bad(wire([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }), theSale()])));
  it("a nonce advance, so it never goes stale", () =>
    bad(wire([SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(key()), authorizedPubkey: trusted.k.publicKey }), theSale()])));
  it("another Heirloom instruction", () => bad(wire([ix.listAsset(new PublicKey(estate), agent.publicKey, new PublicKey(asset.address), 3_600)], { signers: [] })));
  it("another program with the same bytes", () => {
    const t = theSale();
    return bad(wire([new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: t.keys, data: t.data })]));
  });
  it("another fee payer", () => bad(wire([theSale()], { feePayer: trusted.k.publicKey })));
  it("the agent's slot filled", () => bad(wire([theSale()], { signers: [agent, trusted.k] })));
  it("no signature", () => bad(wire([theSale()], { signers: [] })));
  it("a broken signature", () => {
    const w = new Uint8Array(wire());
    w[1 + 64 + 3] ^= 0xff;
    return bad(w);
  });
  it("a signature made over other bytes", () => {
    const [mine, other] = [new Uint8Array(wire()), wire([theSale({ offer: low })])];
    mine.set(other.subarray(65, 129), 65);
    return bad(mine);
  });
  it("a versioned transaction", () => {
    const v = new VersionedTransaction(MessageV0.compile({ payerKey: agent.publicKey, recentBlockhash: HASH, instructions: [theSale()] }));
    v.sign([trusted.k]);
    return bad(v.serialize());
  });
  it("bytes after the message", () => bad(Uint8Array.from([...wire(), 0])));
  it("a cut-off transaction", () => bad(wire().subarray(0, 200)));
  it("an oversized transaction", () => bad(Uint8Array.from([...wire(), ...new Array<number>(1_240 - wire().length).fill(0)])));
  it("text that isn't base64 of anything", () => bad("AAAAA"));
});

describe("the agent is no other account of a sale", () => {
  it("the recipient", async () => {
    asset.proceedsTo = h.agent;
    await refused(await send(b64(wire())), 422, "agent_account");
  });
  it("the buyer: its offer is never eligible", async () => {
    const own = { ...best, buyer: h.agent, amount: 50n, address: offerPda(programId, asset.address, h.agent).toBase58() };
    world.offers.push(own);
    expect((await send(b64(wire()))).status).toBe(200);
    expect(rankOffers(asset, world.offers, world.estate).ineligible.map((o) => o.offer)).toEqual([own.address]);
  });
});

describe("who may co-sign", () => {
  it("nothing without the transaction: the agent can't sell by itself", async () => refused(await send(undefined), 400, "co_sign_required"));
  it("not an outsider", async () => refused(await send(b64(wire()), outsider), 403, "forbidden"));
  it("not a family member while a seat has a holder", async () => refused(await send(b64(wire()), child), 403, "forbidden"));
  it("not a person whose seat was replaced", async () => {
    world.estate.verifiers[0] = key();
    await refused(await send(b64(wire())), 403, "forbidden");
  });
  it("not the buyer", async () => {
    world.estate.verifiers[2] = buyer.address;
    await refused(await send(b64(wire([theSale({ coSigner: buyer.address })], { signers: [buyer.k] })), buyer), 403, "own_offer");
  });
  it("another trusted person can't send what the first signed", async () => refused(await send(b64(wire()), second), 409, "sale_changed"));
  it("the last holder can't co-sign their own offer, so the next best wins", () => {
    const r = rankOffers(asset, [low, best], { agent: h.agent, verifiers: [buyer.address, NOBODY, NOBODY] });
    expect(r.bestOffer).toBe(low.address);
  });

  it("a request signature binds that one transaction, once", async () => {
    const tx = b64(wire());
    const headers = await actionHeaders(trusted, "accept-offer", estate, actionBody.acceptOffer({ asset: asset.address, tx }));
    await refused(await send(b64(wire([theSale({ offer: low })])), trusted, headers), 401, "unauthorized");
    expect((await send(tx, trusted, headers)).status).toBe(200);
    expect((await send(tx, trusted, headers)).status).toBe(401);
  });

  it("the program's refusal reaches the caller as 409", async () => {
    h.refuse = "Rejected by the Heirloom program: OfferChanged: The offer changed";
    await refused(await send(b64(wire())), 409, "OfferChanged");
  });
});

describe("what the program would refuse now is never co-signed (OfferTooOld, ObjectionWindowOpen)", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const guard = (windowSecs: number) => { h.raw[guardPda(programId, estate).toBase58()] = { objection_window_secs: windowSecs }; };

  it("an offer still in its objection window: the agent co-signs only the best offer past it", async () => {
    guard(3_600);
    best.createdAt = now();
    await refused(await send(b64(wire())), 409, "sale_changed");
    const res = await send(b64(wire([theSale({ offer: low })])));
    expect(res.status).toBe(200);
    const { ranking } = (await res.json()) as { ranking: { bestOffer: string; ineligible: { offer: string; readyAt?: number }[] } };
    expect(ranking.bestOffer).toBe(low.address);
    expect(ranking.ineligible).toEqual([expect.objectContaining({ offer: best.address, readyAt: best.createdAt + 3_600 })]);
  });

  it("every offer in its window: nothing is signed", async () => {
    guard(3_600);
    best.createdAt = now();
    low.createdAt = now();
    await refused(await send(b64(wire())), 409, "ObjectionWindowOpen");
  });

  it("a standing hardship approved within the window: nothing is signed", async () => {
    guard(3_600);
    asset.hardshipBeneficiary = child.address;
    h.raw[stampPda(programId, hardshipPda(programId, asset.address, child.address)).toBase58()] = { approved_at: now() };
    await refused(await send(b64(wire([theSale()]))), 409, "ObjectionWindowOpen");
  });

  it("an offer made at or before an upheld objection to the sale was decided: never the one signed", async () => {
    h.raw[objectionPda(programId, asset.address).toBase58()] = { status: { Upheld: {} }, raised_at: 1_000 };
    best.createdAt = 1_000;
    low.createdAt = 1_001;
    await refused(await send(b64(wire())), 409, "sale_changed");
    expect((await send(b64(wire([theSale({ offer: low })])))).status).toBe(200);
  });

  it("a dismissed objection holds nothing back", async () => {
    h.raw[objectionPda(programId, asset.address).toBase58()] = { status: { Dismissed: {} }, raised_at: 1_000 };
    best.createdAt = 1_000;
    expect((await send(b64(wire()))).status).toBe(200);
  });
});

describe("no trusted person left", () => {
  beforeEach(() => { world.estate.verifiers = [NOBODY, NOBODY, NOBODY]; });

  it("waits for the listing to end", async () => refused(await send(undefined, child), 409, "ListingStillOpen"));
  it("then an active family member asks and the agent signs the program's lone path", async () => {
    asset.listingEnds = 1_000;
    expect((await send(undefined, child)).status).toBe(200);
    const t = h.alone[0] as TransactionInstruction;
    const coSignerAt = findInstruction("accept_offer").accounts.findIndex((a) => a.name === "co_signer");
    expect(t.keys[coSignerAt]).toMatchObject({ pubkey: programId, isSigner: false }); // co_signer None
    expect(h.coSigned).toHaveLength(0);
  });
  it("not an outsider, nor a removed family member", async () => {
    asset.listingEnds = 1_000;
    await refused(await send(undefined, outsider), 403, "forbidden");
    world.beneficiaries[0].active = false;
    await refused(await send(undefined, child), 403, "forbidden");
  });
  it("not the buyer", async () => {
    asset.listingEnds = 1_000;
    best.buyer = child.address;
    await refused(await send(undefined, child), 403, "own_offer");
  });
});

describe("the agent's allow-list", () => {
  it("is exactly these eight: no photos, no death resolved, no member or agent changed", () => {
    expect([...AGENT_ALLOWED].sort()).toEqual([
      "accept_offer", "execute_scheduled", "list_asset", "review_claim", "review_death", "review_fallback_death",
      "review_hardship", "review_seat_death",
    ]);
  });

  it("every other instruction of the IDL is refused", () => {
    for (const { name } of getIdl().instructions) {
      const t = new TransactionInstruction({ programId, keys: [], data: Buffer.from(findInstruction(name).discriminator) });
      if ((AGENT_ALLOWED as readonly string[]).includes(name)) expect(() => assertAllowed([t])).not.toThrow();
      else expect(() => assertAllowed([t]), name).toThrow(/not allowed/);
    }
  });

  it("co-signs one sale it pays for, nothing else", () => {
    const pay = (ixs: TransactionInstruction[], feePayer = agent.publicKey) => new Transaction({ feePayer, recentBlockhash: HASH }).add(...ixs);
    const list = ix.listAsset(new PublicKey(estate), agent.publicKey, new PublicKey(asset.address), 3_600);
    expect(() => assertOneSale(pay([theSale()]), h.agent)).not.toThrow();
    expect(() => assertOneSale(pay([theSale(), theSale()]), h.agent)).toThrow();
    expect(() => assertOneSale(pay([list]), h.agent)).toThrow();
    expect(() => assertOneSale(pay([theSale()], trusted.k.publicKey), h.agent)).toThrow();
  });
});
