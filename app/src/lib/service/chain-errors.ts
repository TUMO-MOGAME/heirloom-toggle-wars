/**
 * The chain service's own refusals, shaped like the program's: `code`, and a message that starts with it, which is
 * how the screens find their translated copy. Plus the two things every send needs: a plain failure, and no success
 * before the network confirmed it.
 */
import type { PaymentReceipt } from "../types";
import { programFailure } from "../chain/program-errors";

export class ChainServiceError extends Error {
  constructor(
    public code: string,
    words: string,
    /** Unix seconds from when trying again can work, when that is known. */
    public retryAt?: number,
  ) {
    super(words.startsWith(`${code}: `) ? words : `${code}: ${words}`);
    this.name = "ChainServiceError";
  }
}

/**
 * A transaction was signed and sent, and the network has not given its last word yet (H8). It is never "nothing was
 * paid": the screens show "submitted, checking" on this payment id until it confirms, fails or expires.
 */
export class PaymentPending extends ChainServiceError {
  constructor(public paymentId: string, public signature: string, public kind: string | undefined, words?: string) {
    super("NotConfirmed", words ?? "The network has not confirmed this yet, so don't count on it. It is being checked; don't send it again.");
    this.name = "PaymentPending";
  }
}

/** Sent, and the agent's review did not finish: the request stands, and its sender asks for the review again (H7). */
export function reviewPending(cause: unknown): ChainServiceError {
  const why = cause instanceof Error ? cause.message : String(cause);
  return new ChainServiceError("ReviewPending", `It was sent, but the agent's review didn't finish (${why}). Ask for the review again from the request, with the same file.`);
}

export function must(ok: unknown, code: string, words: string): asserts ok {
  if (!ok) throw new ChainServiceError(code, words);
}

/**
 * Null when the write is confirmed; else the words to fail with. A transaction that was sent but not confirmed is not
 * a success: "the death claim is cancelled" must never be said on a transaction that may not land.
 */
export function writeFailure(r: Pick<PaymentReceipt, "status" | "error" | "signature"> | null): string | null {
  if (r?.status === "confirmed" && r.signature) return null;
  if (!r || r.status === "failed" || !r.signature) {
    const raw = r?.error ?? "Transaction failed.";
    return programFailure(raw) ?? raw;
  }
  return "NotConfirmed: the network has not confirmed this yet, so don't count on it. Open the link, or reload before you try again.";
}
