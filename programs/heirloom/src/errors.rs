use anchor_lang::prelude::*;

/// Codes start at 6000 in this order. Keep in step with docs/program-spec.md and the IDL.
#[error_code]
pub enum HeirloomError {
    #[msg("Signer is not the estate owner")]
    NotOwner,
    #[msg("Signer is not the estate agent")]
    NotAgent,
    #[msg("Signer is not one of the estate verifiers")]
    NotVerifier,
    #[msg("Signer is not an active beneficiary of this estate or rule")]
    NotBeneficiary,
    #[msg("This verifier has already approved")]
    AlreadyApproved,
    #[msg("Thresholds must be between 1 and 3 and the waiting period must not be negative")]
    InvalidThreshold,
    #[msg("Verifiers must be distinct and must not be the owner")]
    DuplicateVerifier,
    #[msg("The account is not in the right status for this action")]
    BadStatus,
    #[msg("There is no death claim to act on")]
    NoDeathClaim,
    #[msg("The agent has not approved this item")]
    AgentNotApproved,
    #[msg("The waiting period is not over yet")]
    WaitingPeriodNotOver,
    #[msg("The payee is not of the kind this rule allows")]
    WrongPayeeKind,
    #[msg("Amount exceeds the per-claim cap")]
    ExceedsPerClaimCap,
    #[msg("Amount exceeds the rule's lifetime cap")]
    ExceedsLifetimeCap,
    #[msg("The rule has expired")]
    RuleExpired,
    #[msg("Not enough verifier approvals")]
    InsufficientApprovals,
    #[msg("Offer is below the floor price")]
    BelowFloor,
    #[msg("Offer is below the hardship floor")]
    BelowHardshipFloor,
    #[msg("The listing is closed")]
    ListingClosed,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("The NFT mint must have 0 decimals and a supply of 1")]
    InvalidNft,
    #[msg("String is too long")]
    StringTooLong,
    #[msg("Token account or mint does not match the estate's USDT mint")]
    WrongMint,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("A recurring rule needs a payee account")]
    PayeeRequired,
    #[msg("The scheduled payment is not due yet")]
    NotDue,
    // ---- guardians (added 2026-11-14; append only, never reorder)
    #[msg("Signer is not a monitor allowed to object here")]
    NotMonitor,
    #[msg("An objection is open on this item")]
    ObjectionOpen,
    #[msg("The objection window is still open")]
    ObjectionWindowOpen,
    #[msg("A succession is already pending for this seat")]
    SuccessionPending,
    #[msg("There is no succession pending for this seat")]
    NoSuccessionPending,
    #[msg("This seat is vacant")]
    SeatVacant,
    #[msg("Not every seat is vacant")]
    SeatsNotVacant,
    #[msg("Signer may not confirm this death, or it is not confirmed yet")]
    NotConfirmer,
    #[msg("The fallback plan is not ready to run")]
    FallbackNotReady,
    #[msg("The fallback plan has already run")]
    FallbackDone,
    #[msg("No living fallback recipient")]
    NoFallbackRecipient,
    #[msg("Invalid backup: must differ from the owner, every trusted person and each other")]
    BadBackup,
    #[msg("Invalid monitor: must differ from the holder they watch and from each other")]
    BadMonitor,
    #[msg("Invalid fallback list: recipients must be distinct and not the owner")]
    BadFallback,
    #[msg("This fallback objection has lapsed: its waiting period is over")]
    ObjectionLapsed,
    #[msg("This objection cannot lapse yet")]
    ObjectionNotLapsed,
    // ---- disputes, yearly caps (added 2026-11-15; append only, never reorder)
    #[msg("Only a beneficiary or a trusted person can dispute")]
    NotDisputer,
    #[msg("This dispute has lapsed: its time to resolve it is over")]
    DisputeLapsed,
    #[msg("Payment would exceed the rule's cap for this year")]
    ExceedsYearlyCap,
    // ---- judge-review fixes (added 2026-11-22; append only, never reorder)
    #[msg("You cannot dispute your own claim")]
    OwnClaimDispute,
    #[msg("That length of time is outside the allowed range")]
    TimeOutOfRange,
    #[msg("An estate can have at most 16 rules")]
    TooManyRules,
    #[msg("Invalid agent: must be a new wallet that is neither the owner nor a trusted person")]
    BadAgent,
    #[msg("Every rule of the estate must be passed, in order")]
    RulesIncomplete,
    #[msg("The owner did not name anyone to receive what is left")]
    NoResidualRecipient,
    #[msg("Nothing is left over: the rules still need what is in the vault")]
    NothingToSweep,
    #[msg("It is too soon to object to this again")]
    ObjectionCooldown,
    // ---- second security review (added 2026-11-22; append only, never reorder)
    #[msg("Signer is not one of the people who may report or refute this")]
    NotParticipant,
    #[msg("You cannot approve or dismiss in your own favour")]
    OwnApproval,
    #[msg("A living trusted person who is not the buyer, the agent or the hardship beneficiary must co-sign this sale")]
    CoSignerRequired,
    #[msg("With no trusted people left, a sale waits for the listing to end")]
    ListingStillOpen,
    #[msg("A real wallet is required")]
    InvalidWallet,
    #[msg("The report changed since it was read")]
    ReportChanged,
    #[msg("A reported death of this recipient is waiting to be confirmed")]
    DeathReportOpen,
    #[msg("The claim belongs to a rule that was ended and replaced")]
    ClaimFromEndedRule,
    #[msg("The offer is no longer the amount that was agreed")]
    OfferChanged,
    // ---- independent review (added 2026-11-23; append only, never reorder)
    #[msg("The owner showed life after this death claim was made")]
    DeathDisproved,
    #[msg("This offer was made before an objection to the sale was upheld")]
    OfferTooOld,
    // ---- finalist hardening (added 2026-11-25; append only, never reorder)
    #[msg("A death must be confirmed by at least two trusted people")]
    DeathQuorumTooLow,
    #[msg("The wait after a death is confirmed must be at least 5 minutes")]
    DeathWaitTooShort,
    #[msg("This rule's beneficiary is still in the plan")]
    BeneficiaryStillActive,
}
