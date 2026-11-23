import "server-only";
/** Server-side estate snapshot: chain state + off-chain names (db) + activity + agent reports. */
import type { EstateSnapshot } from "../service/types";
import { fetchActivity, fetchEstateRaw } from "../chain/reads";
import { assembleSnapshot } from "../chain/snapshot";
import { getEstateMeta, getReports, trustedNames } from "../db";
import { withPrivateNames } from "../chain/public-names";

/**
 * What anyone may know: chain state plus asset titles (things for sale). No family names, no agent reports.
 * For the agent's own routes and for callers who are not members.
 */
export async function loadPublicSnapshot(estate: string): Promise<EstateSnapshot> {
  const meta = await getEstateMeta(estate);
  const raw = await fetchEstateRaw(estate, meta ? { assetTitles: meta.assetTitles } : {});
  return assembleSnapshot(raw, [], {});
}

/** Everything, including names and reports: only after the caller is known to be family. */
export async function loadSnapshot(estate: string): Promise<EstateSnapshot> {
  const meta = await getEstateMeta(estate);
  const raw = await fetchEstateRaw(estate, meta ? {
    ownerName: meta.ownerName, verifierNames: meta.verifierNames, assetTitles: meta.assetTitles, buyerNames: meta.buyerNames,
  } : {});
  const [activity, reports] = await Promise.all([
    fetchActivity(estate).catch(() => []),
    getReports(Object.values(raw.reportHashes)),
  ]);
  // Family labels come only from names the owner gave, so a self-named buyer can't pass as a child (Legacy matching).
  return withPrivateNames(assembleSnapshot(raw, activity, reports), trustedNames(meta));
}
