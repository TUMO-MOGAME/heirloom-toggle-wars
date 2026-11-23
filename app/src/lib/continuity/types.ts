import type { Base58 } from "../types";
import type { TxResult } from "../service/types";

export interface ContinuityService {
  /** Owner, estate Active: the rule stops paying now. Cannot be undone. */
  endRule(estate: Base58, rule: Base58): Promise<TxResult>;
  /** Owner, estate Active: who receives what is left. */
  setResidual(estate: Base58, recipient: Base58): Promise<TxResult>;
  /** Anyone, estate Unlocked: pays out what no live rule still needs. */
  sweepResidual(estate: Base58): Promise<TxResult>;
  /** Owner, estate Active: another agent wallet. Clears an open death claim (proof of life). */
  setAgent(estate: Base58, agent: Base58): Promise<TxResult>;
  /** Trusted person: vote to replace a lost agent. All of them (at least two) while Active, two afterwards. */
  voteAgent(estate: Base58, candidate: Base58): Promise<TxResult>;
  /** Owner, estate Active, asset Held: the title comes back to the owner. */
  releaseAsset(estate: Base58, asset: Base58): Promise<TxResult>;
  /**
   * Owner, estate Active: removes a beneficiary, a payee or both, and ends the live rules that only they could use.
   * `newResidual` is required when the beneficiary being removed is who receives what is left (code "residual").
   */
  removeMember(estate: Base58, input: RemoveMemberInput): Promise<TxResult[]>;
  /**
   * Owner, estate Active: a family member who was removed is in the plan again (add_beneficiary allows it). Rules that
   * ended with the removal stay ended, and their own wallet is not an approved payee again until it is added back.
   */
  restoreMember(estate: Base58, wallet: Base58): Promise<TxResult>;
  /** Test network only: starter SOL and test USD₮ for the active wallet, once. */
  requestStarter(): Promise<TxResult>;
}

export interface RemoveMemberInput { beneficiary?: Base58; payee?: Base58; newResidual?: Base58 }

/** An open vote to replace the agent; only votes for replacing the current agent by people who still hold a seat. */
export interface AgentVoteInfo { candidate: Base58; voters: Base58[] }

export interface CreateEstateOptions {
  /** The plan uses practice wallets: also make practice payees and give each practice person SOL for rent. */
  practice?: boolean;
  /** Beneficiary label of whoever receives what is left (default: the first beneficiary). */
  residualLabel?: string;
}
