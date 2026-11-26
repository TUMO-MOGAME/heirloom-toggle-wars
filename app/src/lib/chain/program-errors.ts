/**
 * The program's refusals in plain words, for the server's answers and the chain service's errors. Each message starts
 * with the error's name: the screens find their translated copy by it (lib/hooks/estate.tsx `explain`).
 *
 * The names are listed here, not read from the IDL, because the wallet imports this file on every page
 * (program-errors.test.ts checks the list against the IDL).
 */
const FIRST_CODE = 6000;
const ACCOUNT_NOT_INITIALIZED = 3012;

/** Code 6000 + position. Append only, like the program's enum. */
export const PROGRAM_ERRORS = [
  "NotOwner", "NotAgent", "NotVerifier", "NotBeneficiary", "AlreadyApproved", "InvalidThreshold", "DuplicateVerifier",
  "BadStatus", "NoDeathClaim", "AgentNotApproved", "WaitingPeriodNotOver", "WrongPayeeKind", "ExceedsPerClaimCap",
  "ExceedsLifetimeCap", "RuleExpired", "InsufficientApprovals", "BelowFloor", "BelowHardshipFloor", "ListingClosed",
  "InvalidAmount", "InvalidNft", "StringTooLong", "WrongMint", "MathOverflow", "PayeeRequired", "NotDue",
  "NotMonitor", "ObjectionOpen", "ObjectionWindowOpen", "SuccessionPending", "NoSuccessionPending", "SeatVacant",
  "SeatsNotVacant", "NotConfirmer", "FallbackNotReady", "FallbackDone", "NoFallbackRecipient", "BadBackup", "BadMonitor",
  "BadFallback", "ObjectionLapsed", "ObjectionNotLapsed",
  "NotDisputer", "DisputeLapsed", "ExceedsYearlyCap",
  "OwnClaimDispute", "TimeOutOfRange", "TooManyRules", "BadAgent", "RulesIncomplete", "NoResidualRecipient",
  "NothingToSweep", "ObjectionCooldown",
  "NotParticipant", "OwnApproval", "CoSignerRequired", "ListingStillOpen", "InvalidWallet", "ReportChanged",
  "DeathReportOpen", "ClaimFromEndedRule", "OfferChanged", "DeathDisproved", "OfferTooOld",
  "DeathQuorumTooLow", "DeathWaitTooShort", "BeneficiaryStillActive",
] as const;

/** Where the program's own message would not tell a family what to do. */
export const PLAIN: Record<string, string> = {
  NotParticipant: "Only the trusted people, their monitors, the family in this plan and the people on the fallback list can do this; only the person who was reported can say they are alive",
  OwnApproval: "You can't approve or dismiss something you would gain from. Someone else has to decide",
  CoSignerRequired: "A trusted person who is not the buyer, the agent or the family member the sale pays has to co-sign this sale",
  ListingStillOpen: "With no trusted people left, the sale has to wait until the listing ends",
  InvalidWallet: "A real wallet address is needed here",
  ReportChanged: "Another report replaced this one while it was being checked, so nothing was decided. Ask for a review of the report that stands now",
  DeathReportOpen: "The next person to be paid was reported to have died. The payment waits until that is confirmed, refuted or too old",
  ClaimFromEndedRule: "This request was made under a rule that has ended and was replaced, so it can't be approved or paid. Make a new request",
  OfferChanged: "The offer changed after it was agreed. Look at the offers again before anyone signs",
  DeathDisproved: "The owner showed they are alive after this passing was reported, so the report no longer counts. If it is true, report it again",
  OfferTooOld: "This offer was made before an objection to the sale was upheld, so it can't be accepted. The buyer has to make a new offer",
  DeathQuorumTooLow: "A passing has to be confirmed by at least two trusted people, so one person and the agent can never unlock the plan",
  DeathWaitTooShort: "The wait after a passing is confirmed has to be at least 5 minutes, so the owner always has time to say they are alive",
  BeneficiaryStillActive: "This rule's family member is still in the plan, so the rule stays. Only a rule for someone the owner removed can be ended now",
};

/** Anchor 3012 says only that an account is missing: what that means here, by the account's name. */
const MISSING: Record<string, string> = {
  payee_account: "This payee was removed from the plan, so it can't be paid",
  payee: "That payee is not in this plan. The owner has to add them first",
  beneficiary_account: "This wallet is not a family member in this plan",
  beneficiary: "That wallet is not a family member in this plan",
  fallback_report: "There is no open report about this person any more",
  objection: "There is no objection to decide any more",
  owner_nft: "The owner's account for this title does not exist yet",
  nft_escrow: "The title is not held by this plan",
  seat: "This trusted person's seat is not set up",
  seat0: "The trusted people's seats are not set up",
  seat1: "The trusted people's seats are not set up",
  seat2: "The trusted people's seats are not set up",
  guard: "The trusted people's safeguards are not switched on for this plan",
  offer: "That offer was withdrawn",
  asset: "That asset is not in this plan any more",
};
const MISSING_ANY = "Something this needs is no longer there: it was removed or already settled. Reload and look again";

function describe(name: string, programMessage?: string, account?: string): string {
  if (name === "AccountNotInitialized") return `${name}: ${(account && MISSING[account]) || MISSING_ANY}`;
  const words = PLAIN[name] ?? programMessage?.trim().replace(/\.$/, "");
  return words ? `${name}: ${words}` : `${name}: the Heirloom program refused this`;
}

/** By number, when the logs are gone (a transaction status, a raw simulation error). */
export function programErrorByCode(code: number): string | null {
  if (code === ACCOUNT_NOT_INITIALIZED) return describe("AccountNotInitialized");
  const name = PROGRAM_ERRORS[code - FIRST_CODE];
  return name ? describe(name) : null;
}

/**
 * Finds the program's refusal in logs, an RPC error message or a stringified transaction error. Null when it holds
 * none (a network error, another program's failure).
 */
export function programFailure(text: string | readonly string[]): string | null {
  const s = typeof text === "string" ? text : text.join("\n");
  const named = s.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n"]*)/);
  if (named) {
    const account = s.match(/caused by account: (\w+)/)?.[1];
    return describe(named[1], named[2], account);
  }
  const custom = s.match(/custom program error: 0x([0-9a-f]+)/i);
  if (custom) return programErrorByCode(Number.parseInt(custom[1], 16));
  const status = s.match(/"Custom"\s*:\s*(\d+)/);
  return status ? programErrorByCode(Number(status[1])) : null;
}
