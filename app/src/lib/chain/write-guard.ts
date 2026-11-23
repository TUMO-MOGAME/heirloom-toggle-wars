/**
 * The tab's half of the version gate (lib/chain/release.ts, plan §18.9 C1), called before anything is signed:
 *  - a tab whose build is not the server's is told to reload (it would sign for a program it doesn't know);
 *  - the deployed program must be the one this build was made for, read from the chain by this tab itself, so a
 *    self-paid write is gated even when the server can't be reached.
 * A good answer is kept for a few seconds, so a plan signed in several transactions asks once.
 */
import { ChainServiceError } from "../service/chain-errors";
import { getConnection } from "./tx";
import { APP_BUILD, RELEASE, RELEASE_WORDS, releaseProblem, type Release } from "./release";

const OK_MS = 15_000;
let okAt = 0;

export interface WriteGuardDeps {
  fetch?: typeof fetch;
  conn?: Parameters<typeof releaseProblem>[0];
  now?: number;
  pin?: Release;
}

/** Throws ChainServiceError "StaleApp" (reload) or "ProgramMismatch" (nothing was signed). */
export async function requireCurrentApp(d: WriteGuardDeps = {}): Promise<void> {
  const now = d.now ?? Date.now();
  if (now - okAt < OK_MS) return;
  const get = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const server = await get("/api/build", { cache: "no-store", signal: AbortSignal.timeout(4_000) })
    .then(async (r) => (r.ok ? ((await r.json()) as { build?: unknown }).build : undefined))
    .catch(() => undefined);
  if (typeof server === "string" && server !== APP_BUILD) {
    throw new ChainServiceError("StaleApp", "Heirloom was updated since this page was opened. Reload the page, then try again. Nothing was signed.");
  }
  const problem = await releaseProblem(d.conn ?? getConnection(), d.pin ?? RELEASE);
  if (problem) throw new ChainServiceError("ProgramMismatch", `Nothing was signed: ${RELEASE_WORDS[problem]}. Please try again later.`);
  okAt = now;
}

/** Tests only. */
export function forgetWriteGuard(): void { okAt = 0; }
