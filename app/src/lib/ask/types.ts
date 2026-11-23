/**
 * "Ask for money" (plan.md §13.1). A family member asks for an amount for a purpose ("School trip, R300"). Under the
 * hood it is an ordinary living claim (submit_claim under a "starts now" rule): the caps are the program's, the owner
 * approves with owner_approve_claim, then execute_claim pays the approved payee. After a passing the same request goes
 * to the trusted people (approve_claim). Nothing new on-chain.
 *
 * What the chain does not hold lives in an AskNote (off-chain, never on-chain): the purpose in the asker's words, the
 * currency they typed, and the owner's "no". The program has no owner decline, and none is needed: while the estate is
 * Active a claim can only be paid after the owner's own approval, so a declined request simply never moves money.
 */
import type { AgentReport, Base58 } from "../types";
import type { TxResult } from "../service/types";

export type AskCurrency = "ZAR" | "USDT";

/** The longest purpose we keep ("School trip to the Cradle of Humankind"). */
export const PURPOSE_MAX = 80;

export interface AskNote {
  claim: Base58;
  /** In the asker's own words (trimmed, at most PURPOSE_MAX characters). */
  purpose: string;
  /** What they typed and in which currency; the claim itself is always in USD₮. */
  currency: AskCurrency;
  typed: number;
  createdAt: number;
  /** True when a letter or quote was attached (otherwise the app's own request note was checked). */
  attachment: boolean;
  /** The owner said no (unix seconds), or null. */
  declinedAt: number | null;
}

export interface AskInput {
  rule: Base58;
  payee: Base58;
  amountUsdt: number;
  purpose: string;
  currency: AskCurrency;
  typed: number;
  /** A letter or quote for the agent to check. Optional: without one the app writes a short request note. */
  evidence?: File | null;
}

export interface AskService {
  /** Beneficiary: ask for money under one of their open rules. Same checks as submitClaim; the agent checks the document. */
  askForMoney(estate: Base58, input: AskInput): Promise<{ tx: TxResult; claim: Base58; report: AgentReport }>;
  /** Owner, while the estate is Active: say no to an open request. Off-chain only (see the file comment). */
  declineAsk(estate: Base58, claim: Base58): Promise<void>;
}

/** The purpose as we store it: no control characters, single spaces, at most PURPOSE_MAX characters. */
export function cleanPurpose(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, PURPOSE_MAX);
}
