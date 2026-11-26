/** Why a chip-in was refused. Pure (no web3.js), shared by the route, the builder and the demo. */
import { MAX_CHIP_IN_USDT } from "./link";

export type ChipInCode =
  | "amount_missing" | "amount_unclear" | "amount_zero" | "amount_too_big" | "bad_account" | "bad_reference" | "bad_estate"
  | "not_active" | "token_unverified" | "no_vault" | "no_usdt" | "not_enough_usdt" | "no_sol" | "demo";

/** Shown by the wallet (ActionError.message), so plain words, no addresses, no names. */
export const CHIP_IN_ERRORS: Record<ChipInCode, string> = {
  amount_missing: "Choose an amount to chip in.",
  amount_unclear: "That amount is not clear. Write it like 50 or 12.50.",
  amount_zero: "Enter an amount above zero.",
  amount_too_big: `One chip-in can be at most ${MAX_CHIP_IN_USDT.toLocaleString("en-US")} USD₮.`,
  bad_account: "That is not a valid Solana wallet address.",
  bad_reference: "This chip-in link is damaged. Ask the family for a new one.",
  bad_estate: "This is not a Heirloom vault on this network.",
  not_active: "This vault is not taking chip-ins right now.",
  token_unverified: "The USD₮ token could not be verified on this network, so nothing was prepared.",
  no_vault: "This vault is not ready for chip-ins yet.",
  no_usdt: "This wallet holds no USD₮ on this network.",
  not_enough_usdt: "This wallet holds less USD₮ than that.",
  no_sol: "This wallet needs a little SOL for the network fee.",
  demo: "This is the Heirloom demo: no money moves here. Chip in on the devnet site with test USD₮.",
};

export class ChipInError extends Error {
  constructor(public code: ChipInCode, public status = 400) { super(CHIP_IN_ERRORS[code]); this.name = "ChipInError"; }
}
