/**
 * Signed writes to /api/asks. The acting wallet signs (ed25519, hex) a short message binding the action, estate, claim,
 * wallet, time and a SHA-256 of the request body. The server verifies it, then checks on-chain that the wallet is the
 * claim's beneficiary (note) or the estate's owner (decline).
 */
export const ASK_MAX_SKEW_MS = 5 * 60 * 1000;

export type AskAction = "note" | "decline";

export function askMessage(action: AskAction, estate: string, claim: string, wallet: string, ts: number, bodyHash: string): string {
  return `Heirloom request\naction:${action}\nestate:${estate}\nclaim:${claim}\nwallet:${wallet}\nts:${ts}\nbody:${bodyHash}`;
}

/** The part of a note that is signed (and hashed), in a fixed key order. */
export function noteBody(n: { purpose: string; currency: string; typed: number; attachment: boolean }): string {
  return JSON.stringify({ purpose: n.purpose, currency: n.currency, typed: n.typed, attachment: n.attachment });
}
