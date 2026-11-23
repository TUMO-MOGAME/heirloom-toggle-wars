/**
 * The two things a wallet signs for Heirloom's server, shared by the browser (signs) and the server (verifies):
 *
 * - An action: one request that makes the agent sign or spend (review, list, settle, starter funds). It binds the
 *   action, estate, wallet, time and a SHA-256 of the request, is at most 5 minutes old and works once.
 * - A read pass: lets this wallet read the records of families it belongs to (names, reports, notes, the tree) for
 *   up to a week without a PIN prompt on every page. It can never authorise a write.
 */
import type { Base58 } from "../types";

export const ACTION_HEADER = "x-heirloom-action";
export const READ_HEADER = "x-heirloom-read";
export const ACTION_MAX_SKEW_MS = 5 * 60 * 1000;
export const READ_PASS_MS = 7 * 24 * 60 * 60 * 1000;

/** "reason": saving the words of one's own dispute or objection (/api/reasons). */
export type AgentAction = "review" | "list-asset" | "accept-offer" | "starter" | "reason";

export function actionMessage(action: AgentAction, estate: Base58, wallet: Base58, ts: number, bodyHex: string): string {
  return `Heirloom agent request\naction:${action}\nestate:${estate}\nwallet:${wallet}\nts:${ts}\nbody:${bodyHex}`;
}

export function readPassMessage(wallet: Base58, exp: number): string {
  return `Heirloom family records: read only\nwallet:${wallet}\nexp:${exp}`;
}

/** What each action's body hash covers. */
export const actionBody = {
  review: (p: { purpose: string; subject?: string; index?: number; sha256: string }) =>
    `${p.purpose}|${p.subject ?? ""}|${p.index ?? ""}|${p.sha256}`,
  listAsset: (p: { asset: Base58; durationSecs: number }) => `${p.asset}|${p.durationSecs}`,
  acceptOffer: (p: { asset: Base58; tx?: string }) => `${p.asset}|${p.tx ?? ""}`,
  starter: () => "starter",
  /** `hash`: the SHA-256 (hex) of the reason's text, as on-chain. */
  reason: (p: { target: Base58; hash: string }) => `${p.target}|${p.hash}`,
};
