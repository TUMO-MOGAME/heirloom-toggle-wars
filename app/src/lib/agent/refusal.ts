import "server-only";
/**
 * The program refused what the agent tried to sign: the caller's news, not a server error. A report was replaced, an
 * offer changed, an objection opened meanwhile.
 */
import { HttpError } from "../api/http";
import { PROGRAM_ERRORS } from "../chain/program-errors";

const NAMES: ReadonlySet<string> = new Set([...PROGRAM_ERRORS, "AccountNotInitialized"]);

/** Use as `.catch(refusedByProgram)`: a program refusal becomes a 409 with the error's name as the code. */
export function refusedByProgram(e: unknown): never {
  const text = e instanceof Error ? e.message : "";
  const name = text.match(/^(?:Rejected by the Heirloom program: )?(\w+): /)?.[1];
  if (name && NAMES.has(name)) throw new HttpError(409, text.replace(/^Rejected by the Heirloom program: /, ""), name);
  throw e;
}
