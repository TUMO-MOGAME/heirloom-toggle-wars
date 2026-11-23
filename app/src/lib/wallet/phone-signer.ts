/**
 * The ActiveSigner methods for a phone wallet, built on a PhoneDriver (./phone.ts). Same contract as the WDK ones in
 * ./context.tsx, so service/chain.ts and the pay-once pipeline (./payments.ts) work unchanged:
 *  - signPartial: the sponsor is the fee payer; only the user's signature is added (message unchanged, checked);
 *  - signOnly: the user pays the fee; the wallet's signed bytes are kept;
 *  - signAndSend: signOnly, then broadcast through our RPC (the wallet never broadcasts, so pay-once holds);
 *  - signMessage: ed25519 over UTF-8, hex (what /api/legacy and /api/media verify).
 */
import bs58 from "bs58";
import type { Base58 } from "../types";
import type { PhoneDriver } from "./phone";
import { phoneCoSign, toHex } from "./phone-sign";

export interface PhoneSigner {
  signAndSend(base64Tx: string): Promise<string>;
  signOnly(base64Tx: string): Promise<{ signature: string; wireBase64: string }>;
  signPartial(base64Tx: string): Promise<{ signature: string; wireBase64: string }>;
  signMessage(message: string): Promise<string>;
}

type Send = (wireBase64: string) => Promise<string>;

/** Broadcasts a signed base64 wire tx through JSON-RPC; returns the signature. Errors carry the program's message. */
export function rpcSender(rpcUrl: string, fetchFn: typeof fetch = fetch): Send {
  return async (wireBase64) => {
    const res = await fetchFn(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [wireBase64, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }] }),
    });
    const data = (await res.json().catch(() => ({}))) as { result?: string; error?: { message?: string; data?: { logs?: string[] } } };
    if (data.result) return data.result;
    const logs = data.error?.data?.logs ?? [];
    const anchor = logs.map((l) => l.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: (.*)$/)).find(Boolean);
    throw new Error(anchor ? `Rejected by the Heirloom program: ${anchor[1]} (${anchor[2].replace(/\.$/, "")})` : data.error?.message ?? `RPC error (${res.status}).`);
  };
}

export function phoneSigner(driver: PhoneDriver, walletName: string, address: Base58, send: Send): PhoneSigner {
  const sign = (wire: Uint8Array) => driver.signTransaction(walletName, address, wire);
  const signOnly = (b64: string) => phoneCoSign(sign, b64, address, bs58.encode, { allowChanges: true });
  return {
    signOnly,
    signPartial: (b64) => phoneCoSign(sign, b64, address, bs58.encode),
    async signAndSend(b64) {
      const { wireBase64, signature } = await signOnly(b64);
      await send(wireBase64);
      return signature;
    },
    async signMessage(message) {
      return toHex(await driver.signMessage(walletName, address, new TextEncoder().encode(message)));
    },
  };
}
