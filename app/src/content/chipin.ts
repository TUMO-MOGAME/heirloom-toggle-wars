/**
 * Chip in (plan §21): the owner's card on the Vault screen and the public page /chip-in/<estate>.
 * The words a wallet shows (label, message, errors) are built on the server in English: lib/chipin/actions.ts and
 * lib/chipin/errors.ts. af/st/zu: content/i18n/chipin.ts.
 */
export const chipin = {
  card: {
    title: "Chip in",
    body: "Family anywhere can add USD₮ to this vault from their own Solana wallet, such as Phantom or Solflare. They scan the code or open the link. No Heirloom account needed.",
    amounts: "Amount the code asks for",
    other: "Other",
    otherLabel: "Other amount in USD₮",
    otherHint: "Up to 10 000 USD₮.",
    qrAlt: "QR code for a chip-in of {amount}. Scan it with a Solana wallet.",
    openWallet: "Open in a wallet",
    copyLink: "Copy link",
    copied: "Link copied",
    share: "Share",
    shareTitle: "Chip in to our family vault",
    shareText: "You can add USD₮ to our family's Heirloom vault from your Solana wallet. No account needed:",
    how: "The wallet shows the amount and asks the sender to approve. The money goes straight into the vault, under the same rules as your own deposits. Senders pay their own small network fee.",
    devnet: "Devnet: test USD₮ only, no real money.",
    demo: "Demo: no wallet can pay here and nothing real moves. Try a simulated chip-in below.",
    recent: "Recent chip-ins",
    none: "No chip-ins yet. They appear here a few seconds after a wallet pays.",
    from: "From {wallet}",
    simulated: "Simulated",
    simulate: "Simulate a chip-in of {amount}",
    simulatedDone: "Simulated: {amount} reached the vault.",
    receipt: "Receipt",
    receiptSr: "Opens Solana Explorer in a new tab",
    refresh: "Check again",
    loadError: "Recent chip-ins could not be loaded. Try again in a moment.",
    amountUnclear: "That amount is not clear. Write it like 50 or 12,50.",
    amountZero: "Enter an amount above zero.",
    amountTooBig: "One chip-in can be at most 10 000 USD₮.",
  },
  page: {
    metaTitle: "Chip in to a family vault",
    metaDescription: "Add USD₮ to a family's Heirloom vault from your own Solana wallet. No account needed.",
    eyebrow: "Chip in",
    title: "Add to a family's *vault*",
    body: "Someone in this family shared this link so you can add USD₮ to their Heirloom vault from your own Solana wallet. No account needed.",
    steps: ["Pick an amount.", "Scan the code with the wallet on your phone, or tap \"Open in a wallet\".", "Check the amount in your wallet and approve."],
    stepsLabel: "How to chip in",
    vault: "Vault",
    safety: "Only USD₮ is accepted, and the vault's contract refuses look-alike tokens. Heirloom never asks for your recovery phrase.",
    badLink: "This link does not point to a vault. Ask the family to share it again.",
  },
};

export type ChipInCopy = typeof chipin;
