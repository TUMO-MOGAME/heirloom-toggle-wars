/**
 * Pure helpers for the phone wallet source (Wallet Standard wallets, Mobile Wallet Adapter on Android).
 * No wallet code is imported here, so this module is cheap and fully unit-tested (phone-sign.test.ts).
 *
 * Fee sponsorship: Heirloom builds a legacy transaction whose fee payer is the sponsor, the user signs it, then
 * /api/sponsor validates and co-signs. A phone wallet signs through `solana:signTransaction` and hands back the
 * whole transaction. The sponsor checks every signature against the exact message it is shown, so the wallet
 * must not change the message (some wallets add a priority fee or other instructions). `phoneCoSign` therefore
 * takes only this wallet's signature out of the returned bytes and puts it into OUR copy of the transaction,
 * after checking the message is byte-for-byte the one we built. If the wallet changed it, we refuse.
 */
import type { Cluster } from "../chain/config";
import { decodeWire, encodeWire } from "./wdk";

/** Wallet Standard chain id for a cluster (the ids MWA and the Solana wallets use). */
export function walletChain(cluster: Cluster): `solana:${string}` {
  return cluster === "mainnet-beta" ? "solana:mainnet" : `solana:${cluster}`;
}

/**
 * Mirrors registerMwa's own check (wallet-standard-mobile 0.7.0): local Mobile Wallet Adapter needs a secure page
 * on Android, in a real browser or a Trusted Web Activity, not inside an app's WebView (a wallet's in-app browser
 * injects its own Wallet Standard wallet instead). Solana Mobile's web shell is a WebView that MWA supports.
 */
export function mwaSupported(userAgent: string, secureContext: boolean): boolean {
  if (!secureContext || !/android/i.test(userAgent)) return false;
  const webView = /(WebView|Version\/.+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)|; wv\).+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+))/i.test(userAgent);
  return !webView || userAgent.includes("Solana Mobile Web Shell");
}

/** Wallet Standard feature names Heirloom needs from a phone wallet. */
export const NEEDED_FEATURES = ["standard:connect", "solana:signTransaction", "solana:signMessage"] as const;

/** The parts of a Wallet Standard wallet the picker looks at. */
export interface StandardWalletLike {
  name: string;
  chains: readonly string[];
  features: Readonly<Record<string, unknown>>;
}

/** Whether a Wallet Standard wallet can sign Heirloom transactions on this cluster (sign-only, legacy transactions). */
export function usableWallet(w: StandardWalletLike, chain: string): boolean {
  if (!NEEDED_FEATURES.every((f) => f in w.features)) return false;
  if (!w.chains.includes(chain)) return false;
  const st = w.features["solana:signTransaction"] as { supportedTransactionVersions?: readonly (string | number)[] } | undefined;
  return !st?.supportedTransactionVersions || st.supportedTransactionVersions.includes("legacy");
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export class PhoneWalletChangedTx extends Error {
  constructor() {
    super("Your phone wallet changed the transaction, so Heirloom's fee sponsor cannot pay for it. Please try again, or use your Heirloom wallet.");
    this.name = "PhoneWalletChangedTx";
  }
}

/**
 * Signs a base64 wire transaction with a phone wallet and returns our copy with only this wallet's signature added.
 * - `sign` is the wallet's signTransaction (wire bytes in, signed wire bytes out).
 * - `me` is the wallet's base58 address; `toBase58` encodes a 32-byte key (bs58, passed in to keep this module light).
 * - `allowChanges`: when the user is the fee payer (no sponsor), a changed message is acceptable, because nobody
 *   else signs it; the wallet's bytes are then returned as they are, provided this wallet's signature is present.
 */
export async function phoneCoSign(
  sign: (wire: Uint8Array) => Promise<Uint8Array>,
  base64Tx: string,
  me: string,
  toBase58: (bytes: Uint8Array) => string,
  opts: { allowChanges?: boolean } = {},
): Promise<{ wireBase64: string; signature: string }> {
  const ours = decodeWire(b64ToBytes(base64Tx));
  const idx = ours.signerKeys.findIndex((k) => toBase58(k) === me);
  if (idx < 0) throw new Error("This wallet is not a signer of the transaction.");

  const returned = decodeWire(await sign(encodeWireBytes(ours.signatures, ours.message)));
  const theirIdx = returned.signerKeys.findIndex((k) => toBase58(k) === me);
  const sig = theirIdx >= 0 ? returned.signatures[theirIdx] : null;
  if (!sig || sig.length !== 64) throw new Error("The phone wallet did not sign the transaction.");

  if (!sameBytes(returned.message, ours.message)) {
    if (!opts.allowChanges) throw new PhoneWalletChangedTx();
    // User pays: keep the wallet's version (the user is the fee payer, so slot 0 is this wallet's signature).
    return { wireBase64: encodeWire(returned.signatures, returned.message), signature: toBase58(sig) };
  }
  const signatures = [...ours.signatures];
  signatures[idx] = sig;
  return { wireBase64: encodeWire(signatures, ours.message), signature: toBase58(sig) };
}

function encodeWireBytes(sigs: (Uint8Array | null)[], message: Uint8Array): Uint8Array {
  return b64ToBytes(encodeWire(sigs, message));
}

/** Lower-case hex, the format /api/legacy and /api/media expect for wallet message signatures. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
