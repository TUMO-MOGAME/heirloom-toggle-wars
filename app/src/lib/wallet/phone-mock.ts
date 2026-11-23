/**
 * Demo mode: a simulated phone wallet, so the demo can show the "Use my phone wallet" flow on any device.
 * It has no keys and signs nothing real: connect() returns a fresh random address, signatures are zero-free
 * random bytes. The start screen shows its own "Simulated phone wallet" approval sheet before calling connect().
 */
import type { PhoneDriver } from "./phone";

export const SIMULATED_PHONE_WALLET = "Simulated phone wallet";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A random base58 string of the length of a Solana address. It holds nothing. */
function randomAddress(): string {
  const rnd = crypto.getRandomValues(new Uint8Array(44));
  return Array.from(rnd, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function mockPhoneDriver(): PhoneDriver {
  return {
    async list() { return [{ name: SIMULATED_PHONE_WALLET, mwa: false, simulated: true }]; },
    async connect(walletName) {
      if (walletName !== SIMULATED_PHONE_WALLET) throw new Error("Unknown wallet.");
      return { address: randomAddress(), walletName };
    },
    async signTransaction(_w, _a, wire) { return wire; },
    async signMessage() { return crypto.getRandomValues(new Uint8Array(64)); },
    async disconnect() { /* nothing to do */ },
  };
}
