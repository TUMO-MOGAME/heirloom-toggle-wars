/**
 * The public, read-only record of an estate (/audit/<estate address>): what anyone with the link may see.
 * It is the estate's on-chain record, with the names the estate screens already show to everyone. Documents
 * appear only as SHA-256 fingerprints: the agent's reports (which quote names, ID numbers and amounts from the
 * documents) are removed.
 */
import type { EstateSnapshot } from "./service/types";
import type { ActivityItem } from "./types";

/** Activity kinds that move money (in, out or into escrow). Everything else is a decision or a setup step. */
export const PAYMENT_KINDS: ReadonlySet<string> = new Set([
  "Deposit", "Withdraw", "ScheduledPaid", "ClaimPaid", "AssetSold", "OfferPlaced", "OfferWithdrawn", "FallbackExecuted",
]);

export const isPayment = (a: ActivityItem) => PAYMENT_KINDS.has(a.kind);

export function auditPayments(snap: EstateSnapshot): ActivityItem[] {
  return snap.activity.filter(isPayment);
}

export function auditDecisions(snap: EstateSnapshot): ActivityItem[] {
  return snap.activity.filter((a) => !isPayment(a));
}

/** The snapshot without the agent's document reports or guardian details; document hashes stay. */
export function publicSnapshot(snap: EstateSnapshot): EstateSnapshot {
  const { agentReport: _death, ...death } = snap.estate.death;
  void _death;
  // Guardians (backups, monitors, objection reasons) are shown in the app to the people involved, not here.
  // So are the extra names the service knows (they include names this device gave backups and monitors).
  const { guardians: _g, names: _n, ...rest } = snap;
  void _g; void _n;
  return {
    ...rest,
    // Bills the owner paid from their own wallet are theirs, not the estate's (lib/bills): not on the public record.
    activity: snap.activity.filter((a) => a.kind !== "BillPaid"),
    estate: { ...snap.estate, death },
    claims: snap.claims.map(({ agentReport: _r, ...c }) => { void _r; return c; }),
    hardships: snap.hardships.map(({ agentReport: _r, ...h }) => { void _r; return h; }),
  };
}

/** True when the error means "there is no estate at this address" (rather than a network problem). */
export function isMissingEstate(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "NoEstate") return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /^No Heirloom estate at |Invalid public key|Non-base58|NoEstate/i.test(msg);
}

/**
 * A base58 address as the audit link carries it. Solana addresses have 32 to 44 characters; the demo's made-up
 * estate address has 45, so up to 48 pass here and the service decides (chain: an invalid key is "not found").
 */
export const looksLikeAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
