/**
 * Copy for spoken receipts (plan §20.1 item 3): the "Hear it" button beside each payment's Explorer link on the
 * statement, the Proof drawer and the public record. The receipt's own sentence is built on the server from the
 * payment (lib/voice/receipts.ts), not here. af/st/zu: content/i18n/receipts.ts.
 */
export const receipts = {
  hear: "Hear it",
  hearSr: "Hear this payment's receipt read aloud",
  stop: "Stop",
  stopSr: "Stop the receipt",
  loading: "Getting the receipt…",
  playing: "Playing the receipt.",
  done: "Receipt played.",
  voice: "Read by Heirloom's ElevenLabs voice.",
  textOnly: "The voice isn't available right now, so here is the receipt to read:",
  notSpoken: "Receipts can't be spoken in this language yet, so here is the receipt to read:",
  machine: "Machine translated",
  failed: "The receipt couldn't be fetched. Try again in a moment.",
  limited: "Too many receipts at once. Wait a minute and try again.",
  notFound: "This payment couldn't be found on the network yet. Try again in a moment.",
};

export type ReceiptsCopy = typeof receipts;
