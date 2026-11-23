import "server-only";
/**
 * Single use of a signed request: on this instance always, and across instances when the shared store is there
 * (plan §18.3 S3). Without it a replay on another instance is bounded by the request's five minutes, by the chain
 * (a second review, listing, settlement or grant is refused there) and by the agent's spend backstop.
 */
import * as store from "../server/shared-store";

export function createNonces(scope: string, ttlMs: number) {
  const seen = new Map<string, number>();
  /** True the first time this id is used. */
  return async function firstUse(id: string, now = Date.now()): Promise<boolean> {
    for (const [k, at] of seen) if (now - at > ttlMs) seen.delete(k);
    if (seen.has(id)) return false;
    seen.set(id, now); // before any await, so two copies arriving together can't both pass
    return (await store.claimSharedOnce(`once:${scope}:${id}`, ttlMs / 1000)) !== false;
  };
}
