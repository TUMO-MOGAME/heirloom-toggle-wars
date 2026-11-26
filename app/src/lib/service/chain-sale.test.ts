/** U4 in the browser: the trusted person's wallet signs the exact best offer; the same bytes pass the agent's check. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getCoder, getIdl } from "../chain/idl";
import { assetPda, estatePda, offerPda } from "../chain/pda";
import type { RawSnapshot } from "../chain/reads";
import type { SaleTiming } from "../agent/offers";

const h = vi.hoisted(() => ({ signer: null as unknown }));
const programId = new PublicKey(getIdl().address);
const usdtMint = Keypair.generate().publicKey;
vi.mock("../chain/client", () => ({ chainCtx: () => ({ programId, usdtMint }) }));
vi.mock("../wallet/signer", () => ({ getActiveSigner: () => h.signer }));
const { acceptBestOffer } = await import("./chain-sale");
const { checkSaleTx } = await import("../agent/sale");
const { actionBody } = await import("../access/messages");

const key = () => Keypair.generate().publicKey.toBase58();
const NOBODY = PublicKey.default.toBase58();
const me = Keypair.generate();
const mine = me.publicKey.toBase58();
const [agent, buyer, lowBuyer] = [key(), key(), key()];
const estate = estatePda(programId, key()).toBase58();
const nftMint = key();
const address = assetPda(programId, estate, nftMint).toBase58();
const asset = { address, nftMint, proceedsTo: estate, hardshipBeneficiary: null, floorPrice: 9n, hardshipFloor: 7n, status: "Listed", listingEnds: 1 };
const offer = (who: string, amount: bigint) => ({ address: offerPda(programId, address, who).toBase58(), asset: address, buyer: who, amount, createdAt: 1 });

let verifiers: string[];
let offers: ReturnType<typeof offer>[];
let posted: { asset: string; tx?: string }[];
let signedBody: string;
let answer: { status: number; body: unknown };
let timing: SaleTiming;

const standing = asset as { hardshipBeneficiary: string | null };

beforeEach(() => {
  standing.hardshipBeneficiary = null;
  verifiers = [mine, key(), key()];
  offers = [offer(lowBuyer, 10n), offer(buyer, 12n)];
  timing = { now: 1_000, objectionWindowSecs: null, saleObjectionUpheldAt: null, hardshipQuorumAt: null };
  posted = [];
  answer = { status: 200, body: { tx: { signature: "s", explorerUrl: "u" }, ranking: { bestOffer: "o", eligible: [{ offer: "o", amount: "12", reason: "" }], ineligible: [] } } };
  h.signer = {
    address: mine,
    signPartial: async (b64: string) => {
      const tx = Transaction.from(Buffer.from(b64, "base64"));
      tx.partialSign(me);
      return { signature: "", wireBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
    },
  };
});

const settle = (seen?: { offer: string; amount: bigint; recipient: string } | null) => acceptBestOffer({
  fetchEstate: async () => ({ estate: { agent, verifiers }, assets: [asset], offers }) as unknown as RawSnapshot,
  latestBlockhash: async () => "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
  saleTiming: async () => timing,
  headers: async (_estate, body) => { signedBody = body; return {}; },
  fetch: (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch,
}, estate, address, seen);

describe("acceptBestOffer", () => {
  it("signs what was read", async () => {
    await settle({ offer: offers[1].address, amount: offers[1].amount, recipient: estate });
    expect(posted).toHaveLength(1);
  });

  it("never signs another amount than was read", async () => {
    await expect(settle({ offer: offers[1].address, amount: offers[1].amount + 1n, recipient: estate })).rejects.toMatchObject({ code: "OfferChanged" });
    expect(posted).toEqual([]);
  });

  it("H11: never signs when who gets the money changed after it was read", async () => {
    await expect(settle({ offer: offers[1].address, amount: offers[1].amount, recipient: lowBuyer })).rejects.toMatchObject({ code: "OfferChanged" });
    expect(posted).toEqual([]);
  });

  it("H11: 'saw no acceptable offer' never signs one that arrived since", async () => {
    await expect(settle(null)).rejects.toMatchObject({ code: "OfferChanged" });
    expect(posted).toEqual([]);
  });

  it("never signs another offer than was read", async () => {
    await expect(settle({ offer: offers[0].address, amount: offers[1].amount, recipient: estate })).rejects.toMatchObject({ code: "OfferChanged" });
    expect(posted).toEqual([]);
  });

  it("signs the highest eligible offer for that amount, and the agent would accept those bytes", async () => {
    const out = await settle();
    expect(out.ranking.eligible[0].amount).toBe(12n);
    const tx = checkSaleTx(Buffer.from(posted[0].tx!, "base64"), { programId, usdtMint }, { estate, agent, asset, offer: offers[1], coSigner: mine });
    expect(String((getCoder().instruction.decode(Buffer.from(tx.instructions[0].data))!.data as { expected_amount: unknown }).expected_amount)).toBe("12");
    expect(signedBody).toBe(actionBody.acceptOffer({ asset: address, tx: posted[0].tx }));
  });

  it("never signs an offer the program would refuse now: made before an upheld sale objection, or still in its window", async () => {
    offers = [{ ...offer(lowBuyer, 10n), createdAt: 600 }, { ...offer(buyer, 12n), createdAt: 500 }];
    timing = { ...timing, saleObjectionUpheldAt: 500 };
    let out = await settle();
    let tx = checkSaleTx(Buffer.from(posted[0].tx!, "base64"), { programId, usdtMint }, { estate, agent, asset, offer: offers[0], coSigner: mine });
    expect(tx.instructions).toHaveLength(1);
    expect(out.ranking).toBeDefined();
    posted = [];
    offers = [offer(lowBuyer, 10n), { ...offer(buyer, 12n), createdAt: 990 }];
    timing = { ...timing, saleObjectionUpheldAt: null, objectionWindowSecs: 60 };
    out = await settle();
    tx = checkSaleTx(Buffer.from(posted[0].tx!, "base64"), { programId, usdtMint }, { estate, agent, asset, offer: offers[0], coSigner: mine });
    expect(tx.instructions).toHaveLength(1);
    // A hardship approved within the window: nothing can be signed yet.
    posted = [];
    timing = { ...timing, hardshipQuorumAt: 990 };
    await expect(acceptBestOffer({
      fetchEstate: async () => ({ estate: { agent, verifiers }, assets: [{ ...asset, hardshipBeneficiary: lowBuyer }], offers }) as unknown as RawSnapshot,
      latestBlockhash: async () => "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", saleTiming: async () => timing, headers: async () => ({}),
    }, estate, address)).rejects.toMatchObject({ code: "ObjectionWindowOpen", retryAt: 1_050 });
    expect(posted).toEqual([]);
  });

  it("only a trusted person", async () => {
    verifiers = [key(), key(), key()];
    await expect(settle()).rejects.toMatchObject({ code: "NotVerifier" });
    expect(posted).toEqual([]);
  });

  it("not for your own offer", async () => {
    offers[1] = offer(mine, 12n);
    await expect(settle()).rejects.toMatchObject({ code: "CoSignerRequired" });
    expect(posted).toEqual([]);
  });

  it("a wallet that can't co-sign says so", async () => {
    h.signer = { address: mine };
    await expect(settle()).rejects.toMatchObject({ code: "CoSignerRequired" });
  });

  it("nothing at or above the floor", async () => {
    offers = [offer(buyer, 8n)];
    await expect(settle()).rejects.toMatchObject({ code: "BelowFloor" });
  });

  it("with no trusted person left nothing is signed in the wallet: the agent's lone path", async () => {
    verifiers = [NOBODY, NOBODY, NOBODY];
    await settle();
    expect(posted[0].tx).toBeUndefined();
  });

  it("P4: the hardship beneficiary never co-signs the sale that pays them", async () => {
    standing.hardshipBeneficiary = mine;
    await expect(settle()).rejects.toMatchObject({ code: "CoSignerRequired" });
    expect(posted).toEqual([]);
  });

  it("P4: with only the hardship beneficiary holding a seat, nothing is signed in the wallet: the agent's lone path", async () => {
    standing.hardshipBeneficiary = mine;
    verifiers = [mine, NOBODY, NOBODY];
    await settle();
    expect(posted[0].tx).toBeUndefined();
  });

  it("the server's refusal keeps its code", async () => {
    answer = { status: 409, body: { error: "OfferChanged: The offer changed", code: "OfferChanged" } };
    await expect(settle()).rejects.toMatchObject({ code: "OfferChanged", message: "OfferChanged: The offer changed" });
  });
});
