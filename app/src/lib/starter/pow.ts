/**
 * The starter's proof of work (plan §18.3 S2): a second or so of hashing on a phone, bound to the wallet and a
 * ten-minute window, so a script can't take a grant per wallet for nothing. No secret and no server state: the
 * server redoes six hashes.
 *
 * Six small puzzles rather than one big one keep the wait steady. Each hash is SHA-256 over 37 bytes (one block).
 * The solver yields every few milliseconds, so the screen stays live.
 */
import { sha256 } from "@noble/hashes/sha2";
import type { Base58 } from "../types";

export const POW = { bits: 15, parts: 6, windowMs: 10 * 60_000, sliceMs: 10 } as const;

export interface StarterProof { window: number; nonces: number[] }

export const powWindow = (now: number) => Math.floor(now / POW.windowMs);

function puzzle(wallet: Base58, window: number): Uint8Array {
  const input = new Uint8Array(37);
  input.set(sha256(new TextEncoder().encode(`Heirloom starter work v1\nwallet:${wallet}\nwindow:${window}`)));
  return input;
}

function setPart(input: Uint8Array, part: number, nonce: number): void {
  input[32] = part;
  input[33] = nonce;
  input[34] = nonce >>> 8;
  input[35] = nonce >>> 16;
  input[36] = nonce >>> 24;
}

/** The first `bits` bits are zero. */
export function hasZeroBits(hash: Uint8Array, bits: number): boolean {
  let left: number = bits;
  for (let i = 0; left > 0; i++, left -= 8) {
    if (left >= 8 ? hash[i] !== 0 : hash[i] >> (8 - left) !== 0) return false;
  }
  return true;
}

/** This window, or the one either side of it (clocks differ, and the PIN may take a moment). */
export function checkProof(wallet: Base58, proof: StarterProof, now = Date.now()): boolean {
  if (!Number.isSafeInteger(proof.window) || Math.abs(proof.window - powWindow(now)) > 1) return false;
  if (proof.nonces.length !== POW.parts) return false;
  const input = puzzle(wallet, proof.window);
  return proof.nonces.every((nonce, part) => {
    if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > 0xffffffff) return false;
    setPart(input, part, nonce);
    return hasZeroBits(sha256(input), POW.bits);
  });
}

/** Gives the browser a turn. A message, not a timeout: nested timeouts wait at least 4 ms each. */
function yieldToBrowser(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export async function solveProof(wallet: Base58, now = Date.now(), pause: () => Promise<void> = yieldToBrowser): Promise<StarterProof> {
  const window = powWindow(now);
  const input = puzzle(wallet, window);
  const nonces: number[] = [];
  await pause(); // so the button's "working" state paints first
  let sliceStart = performance.now();
  for (let part = 0; part < POW.parts; part++) {
    for (let nonce = 0; ; nonce++) {
      setPart(input, part, nonce);
      if (hasZeroBits(sha256(input), POW.bits)) {
        nonces.push(nonce);
        break;
      }
      if ((nonce & 255) === 255 && performance.now() - sliceStart >= POW.sliceMs) {
        await pause();
        sliceStart = performance.now();
      }
    }
  }
  return { window, nonces };
}
