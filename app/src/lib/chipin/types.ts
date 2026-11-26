import type { Base58 } from "../types";

/** One chip-in that reached the vault (chain: found by the estate's tag and checked; demo: simulated). */
export interface ChipIn {
  signature: string;
  explorerUrl: string;
  /** Unix seconds (block time; 0 when the network did not give one). */
  ts: number;
  /** Base units of USD₮ that reached the vault in this transaction. */
  amount: bigint;
  /** The wallet that paid (the fee payer). Shown to the owner as a short address only, never a name. */
  from: Base58;
  /** Demo only: nothing moved on a network. */
  simulated?: boolean;
}

/** Part of HeirloomService: both services list chip-ins; the demo also simulates one (MockService). */
export interface ChipInService {
  /** Recent chip-ins to the estate's vault, newest first (at most 10). Never throws for an empty history. */
  listChipIns(estate: Base58): Promise<ChipIn[]>;
}
