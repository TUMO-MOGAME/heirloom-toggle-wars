import "server-only";
/**
 * The server's half of the version gate (lib/chain/release.ts, plan §18.9 C1): nothing the agent signs or co-signs,
 * and no green /api/health, unless the deployed program is the one this build was made for. One small read, shared
 * for a few seconds; a failed or mismatched check is kept only briefly, so a release is picked up at once.
 */
import { HttpError } from "../api/http";
import { getConnection } from "../chain/tx";
import { RELEASE_WORDS, releaseProblem, type ReleaseProblem } from "../chain/release";

const OK_MS = 10_000;
const BAD_MS = 3_000;

let held: { at: number; ms: number; problem: Promise<ReleaseProblem | null> } | null = null;

/** Null when the deployed program is this build's; else what is wrong. Cached briefly; never throws. */
export function programProblem(now = Date.now()): Promise<ReleaseProblem | null> {
  if (held && now - held.at < held.ms) return held.problem;
  const entry = { at: now, ms: BAD_MS, problem: releaseProblem(getConnection()) };
  held = entry;
  void entry.problem.then((p) => { if (p === null) entry.ms = OK_MS; });
  return entry.problem;
}

/** Throws 503 program_mismatch unless the deployed program is this build's. Before any signature. Always await it. */
export async function assertProgram(): Promise<void> {
  const problem = await programProblem();
  if (problem) {
    throw new HttpError(503, `Nothing was signed: ${RELEASE_WORDS[problem]}. Please try again later.`, "program_mismatch", 60);
  }
}

/** Tests only. */
export function forgetProgramCheck(): void { held = null; }
