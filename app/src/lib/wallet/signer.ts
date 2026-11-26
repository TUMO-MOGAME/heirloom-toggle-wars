/**
 * Module singleton that holds the active wallet's signer, so non-React code (service/chain.ts) can sign
 * with whatever wallet the UI has active. WalletProvider keeps it in sync.
 */
import type { Base58 } from "../types";

export interface ActiveSigner {
  address: Base58;
  signAndSend(base64Tx: string): Promise<string>;
  /** Sign only (WDK), so the payment pipeline can store the signature before broadcasting. */
  signOnly(base64Tx: string): Promise<{ signature: string; wireBase64: string }>;
  /** Partial signature for a tx whose fee payer is Heirloom's fee sponsor. */
  signPartial?(base64Tx: string): Promise<{ signature: string; wireBase64: string }>;
  /** Signs a UTF-8 message with WDK (ed25519, hex). Used to authorise /api/legacy/* requests. */
  signMessage(message: string): Promise<string>;
  /** True when signMessage can run without asking anything (no PIN prompt, no phone wallet app). */
  canSignQuietly?(): boolean;
}

let active: ActiveSigner | null = null;
/** The wallet the UI has active, kept while another one signs in the background (withActiveSigner). */
let chosen: ActiveSigner | null = null;
let pinned = false;
const listeners = new Set<(s: ActiveSigner | null) => void>();

export function setActiveSigner(s: ActiveSigner | null): void {
  chosen = s;
  if (pinned) return; // the background signer stays until its work is done
  active = s;
  listeners.forEach((l) => l(s));
}

/**
 * Runs `work` with `s` as the signer, then puts back the wallet the UI has active. For the guided run (plan §22.2): a
 * practice wallet on this device signs its own step in the background, without switching who is signed in. One at a
 * time; the signing itself is the wallet's own (its PIN, its keys), nothing signs for it.
 */
export async function withActiveSigner<T>(s: ActiveSigner, work: () => Promise<T>): Promise<T> {
  if (pinned) throw new Error("Another wallet is already signing in the background.");
  pinned = true;
  active = s;
  listeners.forEach((l) => l(s));
  try {
    return await work();
  } finally {
    pinned = false;
    active = chosen;
    listeners.forEach((l) => l(chosen));
  }
}

export function getActiveSigner(): ActiveSigner {
  if (!active) throw new Error("No wallet is active. Create or choose a wallet first.");
  return active;
}

export function peekActiveSigner(): ActiveSigner | null {
  return active;
}

export function onSignerChange(fn: (s: ActiveSigner | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
