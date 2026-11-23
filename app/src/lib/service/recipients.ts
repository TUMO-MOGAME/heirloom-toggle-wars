/**
 * The people of the estate on screen as send recipients (bug 18: /send offered only "Someone else" for the owner's
 * own child on the live network). Same shape as the demo's list (mock.ts savedRecipients): names without the role
 * in brackets, the bracket as the relationship. Never the sender, one entry per wallet, estate names first.
 */
import type { Base58, SavedRecipient } from "../types";
import { eligibleSeats } from "../death-rules";
import type { EstateSnapshot } from "./types";

export function estateRecipients(snap: Pick<EstateSnapshot, "estate" | "beneficiaries">, me: Base58): SavedRecipient[] {
  const e = snap.estate;
  const all: SavedRecipient[] = [
    ...snap.beneficiaries.filter((b) => b.active).map((b) => ({ label: b.label.replace(/\s*\(.*\)$/, ""), address: b.wallet, relationship: b.label.match(/\((.*)\)/)?.[1] })),
    // An empty seat holds the all-zero key: money sent there would be gone.
    ...eligibleSeats(e.verifiers).map((i) => ({ label: e.verifierNames[i], address: e.verifiers[i], relationship: i === 0 ? "executor" : "trusted person" })),
    { label: e.ownerName, address: e.owner, relationship: "estate owner" },
  ];
  return mergeRecipients(all.filter((r) => r.address !== me && r.label));
}

/** One entry per wallet; the first list that names a wallet wins. */
export function mergeRecipients(...lists: SavedRecipient[][]): SavedRecipient[] {
  const seen = new Map<Base58, SavedRecipient>();
  for (const list of lists) for (const r of list) if (!seen.has(r.address)) seen.set(r.address, r);
  return [...seen.values()];
}
