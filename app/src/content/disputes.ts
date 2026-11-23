/**
 * Copy for disputes (U9) and yearly caps, added 15 Nov 2026. Shared through the shell copy provider
 * (`useCopy().disputes`), because these parts appear on several screens (Claims, Inbox, Timeline, Estate).
 * {curly} values are filled at runtime. English is the source; other languages may leave keys out.
 */
export const disputes = {
  /** Contract error names in plain words (merged into the errors map for the Blocked card and toasts). */
  errors: {
    NotDisputer: "Only a family member named in the plan or one of the trusted people can dispute this.",
    DisputeLapsed: "This dispute has lapsed: it wasn't decided in time, so the paused step can go ahead.",
    ExceedsYearlyCap: "That is more than this rule allows for the rest of this year.",
  } as Record<string, string>,

  raise: {
    cta: "Dispute this",
    /** On the waiting-period step: it stops the estate unlocking, so it must not read like a claim dispute. */
    ctaUnlock: "Dispute the unlock",
    titleClaim: "Dispute this payment",
    titleUnlock: "Dispute the unlock",
    body: "A dispute pauses it until two trusted people decide. If they don't decide within {period}, the dispute lapses and the step goes ahead.",
    reason: "Why are you disputing it?",
    reasonHint: "Only a fingerprint (hash) of your reason is recorded on the blockchain. The words themselves stay off it.",
    needReason: "Write a short reason (at least 10 characters).",
    submit: "Pause and dispute",
    cancel: "Cancel",
    done: "Dispute raised. This step is paused until the trusted people decide.",
    once: "This has already been disputed once, so it can't be paused again.",
  },

  card: {
    title: "Dispute",
    by: "{name} disputed this",
    aboutClaim: "About: {amount} to {payee}",
    aboutUnlock: "About: unlocking the estate after the waiting period",
    reason: "Their reason",
    noReason: "The reason was written on another device. Its fingerprint is below.",
    fingerprint: "Fingerprint",
    status: { Open: "Paused", Upheld: "Upheld", Dismissed: "Dismissed", Lapsed: "Lapsed" },
    votes: "{up} to uphold, {down} to dismiss. Two decide.",
    lapses: "Lapses in {time} if it isn't decided",
    youDecide: "You are a trusted person: your vote counts. The person who raised a dispute can't decide it.",
    uphold: "Uphold: cancel it",
    dismiss: "Dismiss: let it go ahead",
    voted: "You have voted. Waiting for another trusted person.",
    payPaused: "This payment is paused by a dispute. You can pay it once two trusted people dismiss the dispute or it lapses.",
    upheld: "Your vote to uphold is recorded.",
    dismissed: "Your vote to dismiss is recorded.",
    outcome: {
      Claim: {
        Upheld: "Upheld by two trusted people: this payment was cancelled.",
        Dismissed: "Dismissed by two trusted people: the payment can go ahead.",
        Lapsed: "Not decided in time, so the dispute lapsed: the payment can go ahead.",
      },
      Unlock: {
        Upheld: "Upheld by two trusted people: the unlock was stopped and the vault stays locked.",
        Dismissed: "Dismissed by two trusted people: the estate can unlock when the waiting period ends.",
        Lapsed: "Not decided in time, so the dispute lapsed: the estate can unlock when the waiting period ends.",
      },
    },
  },

  list: { title: "Disputes to decide", empty: "No disputes are waiting for you." },

  family: {
    title: "Pending payments for the family",
    body: "Payments waiting to be made for your brothers and sisters. If one looks wrong, you can dispute it before it is paid.",
  },

  yearly: {
    used: "{spent} of {cap} used this year",
    left: "{amount} left this year",
    resets: "The year restarts on {date}",
    meter: "Yearly limit used for {category}",
    none: "No yearly limit",
    set: "Set a yearly limit",
    change: "Change the yearly limit",
    formTitle: "Yearly limit for {category}",
    formBody: "The most this rule may pay in any 12 months, on top of the per-claim and total limits. Claims and scheduled payments both count.",
    label: "Most per year (USD₮)",
    hint: "Between {min} and {max}. The year starts today.",
    invalid: "Enter an amount from {min} to {max}.",
    save: "Save the limit",
    cancel: "Cancel",
    done: "Yearly limit saved.",
    claimLeft: "This rule pays at most {cap} a year: {left} is left this year.",
  },
};

export type DisputesCopy = typeof disputes;
