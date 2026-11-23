/** The browser's half of the starter (plan §18.3 S2): sign, do the small proof of work, ask, and keep the reason of a no. */
import type { Base58 } from "../types";
import type { TxResult } from "../service/types";
import { actionHeaders } from "../access/client";
import { actionBody } from "../access/messages";
import { solveProof } from "./pow";

export class StarterError extends Error {
  constructor(message: string, public code: string, public retryAfterSecs?: number) {
    super(message);
    this.name = "StarterError";
  }
}

interface Signer { address: Base58; signMessage(message: string): Promise<string> }

export async function requestStarterFunds(signer: Signer, send: typeof fetch = (...a) => fetch(...a)): Promise<TxResult> {
  const wallet = signer.address;
  // The signature first: if the wallet asks for its PIN, it asks straight away.
  const signed = await actionHeaders(signer, "starter", wallet, actionBody.starter());
  const proof = await solveProof(wallet);
  let res: Response;
  try {
    res = await send("/api/starter", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json", ...signed }, body: JSON.stringify({ wallet, proof }),
    });
  } catch {
    throw new StarterError("The request did not get through.", "busy", 60);
  }
  const data = (await res.json().catch(() => ({}))) as Partial<TxResult> & { error?: string; code?: string; retryAfter?: number };
  if (res.ok && data.signature) return data as TxResult;
  throw new StarterError(data.error ?? `Request failed (${res.status}).`, data.code ?? "failed", data.retryAfter);
}
