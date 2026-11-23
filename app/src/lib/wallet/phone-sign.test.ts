import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { findInstruction, getIdl } from "../chain/idl";
import { DEFAULT_LIMITS, SPONSORED_HEIRLOOM_IXS, SponsorRejection, validateSponsoredTx, type SponsorPolicy } from "../sponsor/policy";
import { verifyEd25519 } from "../legacy/server/auth";
import { mwaSupported, phoneCoSign, PhoneWalletChangedTx, usableWallet, walletChain, toHex } from "./phone-sign";
import { phoneSigner, rpcSender } from "./phone-signer";
import { mockPhoneDriver, SIMULATED_PHONE_WALLET } from "./phone-mock";
import { signSponsoredOrSelf, type SponsorClient } from "./payments";
import type { PhoneDriver } from "./phone";

const sponsor = Keypair.generate();
const user = Keypair.generate();
const mint = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
/** ed25519 detached signature with a web3.js Keypair (node:crypto, PKCS#8 from the 32-byte seed). */
const detached = (m: Uint8Array, kp: Keypair) =>
  new Uint8Array(edSign(null, m, createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" })));
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const programId = new PublicKey(getIdl().address);
const names = getIdl().instructions.map((i) => i.name);
const policy: SponsorPolicy = {
  sponsor: sponsor.publicKey, usdtMint: mint, usdtDecimals: 6, heirloomProgram: programId,
  heirloomDiscriminators: Object.fromEntries(SPONSORED_HEIRLOOM_IXS.filter((n) => names.includes(n)).map((n) => [n, findInstruction(n).discriminator])),
  ...DEFAULT_LIMITS, sponsorPaysRent: true,
};
const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true);
const transfer = () => createTransferCheckedInstruction(ata(user.publicKey), mint, ata(recipient), user.publicKey, 1_000_000n, 6);
const heartbeat = () => new TransactionInstruction({ programId, keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([...findInstruction("heartbeat").discriminator]) });

/** Unsigned base64 wire tx, as service/chain.ts builds it. */
const unsigned = (ixs: TransactionInstruction[], feePayer = sponsor.publicKey) =>
  new Transaction({ feePayer, recentBlockhash: BLOCKHASH }).add(...ixs).serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

/** A Wallet Standard wallet's signTransaction, as Phantom / Solflare / Seed Vault behave over MWA. */
const honestWallet = (kp: Keypair) => async (wire: Uint8Array) => {
  const tx = Transaction.from(Buffer.from(wire));
  tx.partialSign(kp);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
};
/** A wallet that adds its own priority fee before signing (changes the message). */
const meddlingWallet = (kp: Keypair) => async (wire: Uint8Array) => {
  const old = Transaction.from(Buffer.from(wire));
  const tx = new Transaction({ feePayer: old.feePayer!, recentBlockhash: old.recentBlockhash! })
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...old.instructions);
  tx.partialSign(kp);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
};
/** A wallet that returns the bytes without signing. */
const lazyWallet = async (wire: Uint8Array) => wire;

describe("phone wallet: chain ids and support checks", () => {
  it("maps clusters to Wallet Standard chains", () => {
    expect(walletChain("devnet")).toBe("solana:devnet");
    expect(walletChain("mainnet-beta")).toBe("solana:mainnet");
    expect(walletChain("localnet")).toBe("solana:localnet");
  });

  it("offers Mobile Wallet Adapter only on Android, in a secure page, outside app WebViews", () => {
    const chrome = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
    const webView = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
    expect(mwaSupported(chrome, true)).toBe(true);
    expect(mwaSupported(chrome, false)).toBe(false);
    expect(mwaSupported(webView, true)).toBe(false);
    expect(mwaSupported(`${webView} Solana Mobile Web Shell`, true)).toBe(true);
    expect(mwaSupported("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", true)).toBe(false);
    expect(mwaSupported("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36", true)).toBe(false);
  });

  it("only lists wallets that can connect, sign transactions and messages on this cluster, with legacy transactions", () => {
    const features = { "standard:connect": {}, "solana:signTransaction": { supportedTransactionVersions: ["legacy", 0] }, "solana:signMessage": {} };
    expect(usableWallet({ name: "A", chains: ["solana:devnet"], features }, "solana:devnet")).toBe(true);
    expect(usableWallet({ name: "B", chains: ["solana:mainnet"], features }, "solana:devnet")).toBe(false);
    expect(usableWallet({ name: "C", chains: ["solana:devnet"], features: { ...features, "solana:signMessage": undefined } as never }, "solana:devnet")).toBe(true);
    const { ["solana:signMessage"]: _drop, ...noMsg } = features;
    void _drop;
    expect(usableWallet({ name: "D", chains: ["solana:devnet"], features: noMsg }, "solana:devnet")).toBe(false);
    expect(usableWallet({ name: "E", chains: ["solana:devnet"], features: { ...features, "solana:signTransaction": { supportedTransactionVersions: [0] } } }, "solana:devnet")).toBe(false);
  });
});

describe("phone wallet + fee sponsor (the user signs, the sponsor pays)", () => {
  it("a phone wallet's partial signature passes the sponsor policy, and the sponsor's co-signature completes it", async () => {
    const b64 = unsigned([transfer(), heartbeat()]);
    const partial = await phoneCoSign(honestWallet(user), b64, user.publicKey.toBase58(), bs58.encode);
    const wire = Buffer.from(partial.wireBase64, "base64");
    // The server-side policy accepts it: fee payer = sponsor, its slot empty, the user's signature valid.
    const d = validateSponsoredTx(wire, policy);
    expect(d.signers).toEqual([user.publicKey.toBase58()]);
    // Sponsor co-signs (as agentCoSign does) and the result verifies with every signature.
    const tx = Transaction.from(wire);
    expect(tx.signatures[0].signature).toBeNull();
    tx.partialSign(sponsor);
    expect(tx.verifySignatures()).toBe(true);
    expect(partial.signature).toBe(bs58.encode(tx.signatures[1].signature!));
  });

  it("refuses when the wallet changed the message, so the sponsor is never shown a different transaction", async () => {
    const b64 = unsigned([transfer()]);
    await expect(phoneCoSign(meddlingWallet(user), b64, user.publicKey.toBase58(), bs58.encode)).rejects.toBeInstanceOf(PhoneWalletChangedTx);
  });

  it("refuses a wallet that did not sign, and a wallet that is not a signer", async () => {
    const b64 = unsigned([transfer()]);
    await expect(phoneCoSign(lazyWallet, b64, user.publicKey.toBase58(), bs58.encode)).rejects.toThrow(/did not sign/);
    await expect(phoneCoSign(honestWallet(user), b64, Keypair.generate().publicKey.toBase58(), bs58.encode)).rejects.toThrow(/not a signer/);
  });

  it("an unsigned (or only partly signed) phone transaction is refused by the sponsor policy", () => {
    expect(() => validateSponsoredTx(Buffer.from(unsigned([transfer()]), "base64"), policy)).toThrow(SponsorRejection);
  });

  it("user pays (no sponsor): the wallet's own bytes are kept, even if it added a priority fee", async () => {
    const b64 = unsigned([transfer()], user.publicKey);
    const out = await phoneCoSign(meddlingWallet(user), b64, user.publicKey.toBase58(), bs58.encode, { allowChanges: true });
    const tx = Transaction.from(Buffer.from(out.wireBase64, "base64"));
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.instructions).toHaveLength(2);
    expect(out.signature).toBe(bs58.encode(tx.signature!)); // tx id = fee payer's (the user's) signature
  });

  it("runs through the pay-once pipeline's sponsored path with a phone signer", async () => {
    const driver: PhoneDriver = {
      list: async () => [], connect: async () => ({ address: user.publicKey.toBase58(), walletName: "Test" }),
      signTransaction: (_n, _a, wire) => honestWallet(user)(wire),
      signMessage: async (_n, _a, m) => detached(m, user),
      disconnect: async () => undefined,
    };
    const send = vi.fn(async () => "sent");
    const signer = phoneSigner(driver, "Test", user.publicKey.toBase58(), send);
    const sponsorClient: SponsorClient = {
      status: async () => ({ available: true, feePayer: sponsor.publicKey.toBase58(), maxFeeLamports: 20_000, paysRent: true }),
      async cosign(wireBase64) {
        const wire = Buffer.from(wireBase64, "base64");
        validateSponsoredTx(wire, policy);
        const tx = Transaction.from(wire);
        tx.partialSign(sponsor);
        return { signature: bs58.encode(tx.signature!), wireBase64: tx.serialize().toString("base64") };
      },
    };
    const signed = await signSponsoredOrSelf({
      user: user.publicKey.toBase58(),
      build: async (feePayer) => ({ base64: unsigned([transfer()], new PublicKey(feePayer)), lastValidBlockHeight: 100 }),
      signPartial: signer.signPartial, signOnly: signer.signOnly, sponsor: sponsorClient,
    });
    expect(signed.sponsored).toBe(true);
    expect(signed.feePayer).toBe(sponsor.publicKey.toBase58());
    expect(Transaction.from(Buffer.from(signed.wireBase64, "base64")).verifySignatures()).toBe(true);
    expect(send).not.toHaveBeenCalled(); // the pipeline broadcasts, never the wallet

    // signMessage gives the hex ed25519 signature the /api/legacy and /api/media servers verify.
    const sig = await signer.signMessage("heirloom:test");
    expect(verifyEd25519(user.publicKey.toBase58(), "heirloom:test", sig)).toBe(true);
    expect(sig).toBe(toHex(detached(new TextEncoder().encode("heirloom:test"), user)));

    // signAndSend signs, then broadcasts through our RPC sender.
    await signer.signAndSend(unsigned([transfer()], user.publicKey));
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("rpcSender", () => {
  it("returns the signature, or the Heirloom program's error from the logs", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ result: "SIG" })));
    expect(await rpcSender("https://rpc.test", ok as unknown as typeof fetch)("AAA")).toBe("SIG");
    const body = JSON.parse(String((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.method).toBe("sendTransaction");
    expect(body.params[1].encoding).toBe("base64");
    const bad = async () => new Response(JSON.stringify({ error: { message: "x", data: { logs: ["Program log: AnchorError occurred. Error Code: CapExceeded. Error Number: 6001. Error Message: Over the cap."] } } }));
    await expect(rpcSender("https://rpc.test", bad as unknown as typeof fetch)("AAA")).rejects.toThrow("Rejected by the Heirloom program: CapExceeded (Over the cap)");
  });
});

describe("simulated phone wallet (demo mode)", () => {
  it("offers one clearly simulated wallet and connects to a fresh address", async () => {
    const d = mockPhoneDriver();
    const list = await d.list();
    expect(list).toEqual([{ name: SIMULATED_PHONE_WALLET, mwa: false, simulated: true }]);
    const a = await d.connect(SIMULATED_PHONE_WALLET);
    const b = await d.connect(SIMULATED_PHONE_WALLET);
    expect(a.address).not.toBe(b.address);
    expect(a.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
    await expect(d.connect("Phantom")).rejects.toThrow();
  });
});
