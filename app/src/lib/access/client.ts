/** Browser half of lib/access/messages.ts: signs actions, and keeps each wallet's read pass on this device. */
import type { Base58 } from "../types";
import { sha256Hex } from "../agent/hash";
import { peekActiveSigner } from "../wallet/signer";
import { ACTION_HEADER, READ_HEADER, READ_PASS_MS, actionMessage, readPassMessage, type AgentAction } from "./messages";

interface Signer { address: Base58; signMessage(message: string): Promise<string> }
interface ReadPass { wallet: Base58; exp: number; sig: string }

const storeKey = (wallet: Base58) => `heirloom.read.${wallet}`;
/** Renew a day before it runs out, so a pass never lapses mid-visit. */
const RENEW_MS = 24 * 60 * 60 * 1000;
/** Where storage is unavailable (private window, blocked site data) the pass lives for this tab only. */
const memory = new Map<Base58, ReadPass>();

export async function actionHeaders(signer: Signer, action: AgentAction, estate: Base58, body: string, now = Date.now()): Promise<Record<string, string>> {
  const sig = await signer.signMessage(actionMessage(action, estate, signer.address, now, await sha256Hex(body)));
  return { [ACTION_HEADER]: JSON.stringify({ wallet: signer.address, ts: now, sig }) };
}

function loadPass(wallet: Base58, now: number): ReadPass | null {
  let pass = memory.get(wallet) ?? null;
  if (!pass) {
    try {
      const raw = localStorage.getItem(storeKey(wallet));
      if (raw) pass = JSON.parse(raw) as ReadPass;
    } catch { /* no storage: memory only */ }
  }
  return pass && pass.wallet === wallet && pass.exp > now ? pass : null;
}

/** Signs a read pass when there is none or it is about to run out. Call only when signing needs no prompt. */
export async function ensureReadPass(signer: Signer, now = Date.now()): Promise<void> {
  const held = loadPass(signer.address, now);
  if (held && held.exp - now > RENEW_MS) return;
  const exp = now + READ_PASS_MS;
  const pass: ReadPass = { wallet: signer.address, exp, sig: await signer.signMessage(readPassMessage(signer.address, exp)) };
  memory.set(signer.address, pass);
  try { localStorage.setItem(storeKey(signer.address), JSON.stringify(pass)); } catch { /* memory only */ }
}

export function forgetReadPass(wallet: Base58): void {
  memory.delete(wallet);
  try { localStorage.removeItem(storeKey(wallet)); } catch { /* nothing stored */ }
}

/** The active wallet's read header, or none (then the server answers with public data only). */
export function readHeaders(now = Date.now()): Record<string, string> {
  const wallet = peekActiveSigner()?.address;
  const pass = wallet ? loadPass(wallet, now) : null;
  return pass ? { [READ_HEADER]: JSON.stringify(pass) } : {};
}

/** For cache keys: changes when the reader changes or gets a pass. */
export function readerKey(): string {
  const wallet = peekActiveSigner()?.address;
  return wallet && loadPass(wallet, Date.now()) ? wallet : "public";
}
