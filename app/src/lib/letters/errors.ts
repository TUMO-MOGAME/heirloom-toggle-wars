/**
 * Letter errors with a code the screen can explain in the visitor's language (content/letters.ts errors.*). The same
 * codes come back from /api/letters, so the mock and the chain service fail the same way.
 */
export type LetterErrorCode =
  | "forbidden" | "paused" | "sealed" | "opened" | "version" | "too_large" | "bad_letter" | "bad_link" | "full"
  | "unavailable" | "network" | "not_family";

export class LetterError extends Error {
  constructor(public code: LetterErrorCode, message: string, public field?: string) {
    super(message);
    this.name = "LetterError";
  }
}

const KEYS: Record<LetterErrorCode, string> = {
  forbidden: "forbidden", paused: "paused", sealed: "sealed", opened: "opened", version: "version", too_large: "tooLarge",
  bad_letter: "badLetter", bad_link: "badLink", full: "full", unavailable: "unavailable", network: "network", not_family: "notFamily",
};

/** The copy key (content/letters.ts errors.*) for an error, or null when it is not a letter error. */
export function letterErrorKey(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code in KEYS ? KEYS[code as LetterErrorCode] : null;
}
