/**
 * Copy for "Ask for money" (plan.md §13.1), added 16 Nov 2026: the ask sheet, the request's status, and the cards on
 * the chat home. Components read it with `useLocalized(ask, (t) => t.ask)`. {curly} values are filled at runtime.
 * English is the source; af/st/zu are in content/i18n/ask.ts and must translate every key (content/ask.test.ts).
 */
export const ask = {
  entry: "Ask for money",
  sheet: {
    title: "Ask for money",
    descOwner: "{owner} gets your request and decides. If yes, it is paid straight to the place you choose.",
    descTrusted: "Your trusted people check it. Usually one approval is enough to pay it, straight to the place you choose.",
    close: "Close",
    purposeLabel: "What is it for?",
    purposeHint: "A few words, like a school trip.",
    purposeError: "Say what the money is for.",
    ideasLabel: "Ideas",
    ideas: ["School trip", "Books", "Transport", "Data", "Uniform"],
    amountLabel: "How much?",
    currencyLabel: "Currency",
    rand: "Rand",
    usdt: "USD₮",
    about: "About {amount}",
    noRate: "Rand amounts need today's rate, which is not available. Enter USD₮ instead.",
    amountError: "Enter an amount above zero.",
    payeeLabel: "Pay it to",
    payeeHint: "Only places on the approved list. A request can't be paid anywhere else.",
    ownWallet: "Your own wallet",
    limits: "Up to {max} at a time · {left} left",
    yearLeft: "{amount} left this year",
    over: {
      ExceedsPerClaimCap: "That is more than this rule pays at a time. Ask for {limit} or less.",
      ExceedsLifetimeCap: "Only {limit} is left under this rule.",
      ExceedsYearlyCap: "Only {limit} is left under this rule this year.",
    },
    overNote: "The plan itself would refuse this, so it cannot be sent.",
    vaultLow: "The vault holds {vault} right now, so this can only be paid once it is topped up.",
    attachLabel: "A letter or quote (optional)",
    attachHint: "If the school sent a letter, add it. The agent checks that it matches.",
    samples: [{ label: "School trip letter", fileName: "school-trip-letter.pdf" }],
    removeFile: "Remove the letter",
    submit: "Send request",
    sending: "Sending your request",
    none: "There is nothing you can ask for right now.",
    noneActive: "{owner}'s plan has no rule you can ask under yet. Ask {owner} to add one for everyday needs.",
    nonePaused: "Requests are paused while a passing is being confirmed.",
  },
  result: {
    sentOwner: "Sent to {owner}",
    sentTrusted: "Sent to your trusted people",
    bodyOwner: "{owner} sees it on their home screen and decides. You will see the answer on yours.",
    bodyTrusted: "A trusted person sees it in their inbox. Usually one approval is enough to pay it.",
    noDoc: "No letter was attached, so the decision rests on your words.",
    refused: "Your request could not go ahead",
    refusedBody: "The agent could not accept the letter. Ask again with a clear copy, or without a letter.",
    done: "Done",
    another: "Ask for something else",
  },
  status: {
    checking: "Being checked",
    refused: "Not accepted",
    waiting: "Waiting",
    declined: "Declined",
    approved: "Approved",
    paid: "Paid",
  },
  line: {
    for: "For: {purpose}",
    waitingOwner: "Waiting for {owner} to decide",
    waitingTrusted: "Waiting for a trusted person",
    declined: "{owner} said no",
  },
  nudges: {
    owner: {
      title: "{name} asks for money",
      body: "{purpose}: {amount}{zar}, paid to {payee}.",
      bodyNoPurpose: "{amount}{zar}, paid to {payee}.",
      checked: "I checked the letter and it matches.",
      noDoc: "No letter attached, so it is your call.",
      approve: "Approve and pay",
      decline: "Decline",
      paused: "{name} disputed this, so it is paused until two trusted people decide or the dispute lapses.",
      pausedCta: "See the dispute",
    },
    asker: {
      waitingOwner: "Your request is with {owner}",
      waitingTrusted: "Your request is with your trusted people",
      waitingBody: "{purpose}: {amount}{zar}. You will see here when it is decided.",
      paid: "Paid: {purpose}",
      paidBody: "{amount}{zar} went to {payee}.",
      declined: "{owner} said no to: {purpose}",
      declinedBody: "You can talk to {owner}, or ask again for something different.",
      refused: "Your request could not go ahead",
      refusedBody: "The agent could not accept the letter for \"{purpose}\". Ask again with a clear copy, or without one.",
      yourWallet: "your own wallet",
      see: "See my requests",
      again: "Ask again",
    },
    declinedToast: "Declined. {name} will see your answer.",
    paidToast: "Paid to {payee}.",
  },
  claims: {
    decline: "Decline",
  },
};

export type AskCopy = typeof ask;

/**
 * The request note the agent reads when nothing was attached (lib/ask/note-pdf.ts). Kept in English on purpose, like
 * the agent-read drafts: it is a document for the reviewer, not text on screen.
 */
export const askNote = {
  title: "Heirloom request note",
  from: "Asked by",
  for: "For",
  amount: "Amount",
  typed: "typed as",
  to: "Paid to",
  date: "Date",
  footer: "Written by the Heirloom app from the family member's request. No letter or quote was attached.",
};
