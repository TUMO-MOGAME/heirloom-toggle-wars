/**
 * The estates a wallet has a part in, besides owning one: what the estate switcher lists, so "I'm alive" (R4) and a
 * confirmation work without a ?estate= link.
 *
 * A backup and a fallback recipient are listed as "monitor", like a seat's monitor: the role of somebody who watches
 * and may have to confirm or answer, and who is neither a trusted person nor (by that alone) an heir.
 *
 * All lookups are asked at once, so they are filters over the one shared program scan (reads.ts): one
 * getProgramAccounts call however many ways a wallet can be named. A filtered call each would be twelve, which the
 * public devnet RPC throttles.
 */
import { PublicKey } from "@solana/web3.js";
import type { Base58, Role } from "../types";
import { bool } from "./decoders";
import { GUARD_FALLBACK_OFFSETS, SEAT_BACKUP_OFFSETS, SEAT_MONITOR_OFFSETS } from "./guardians";
import { decodeScanned, scanAccounts, type ProgramAccount } from "./reads";

/** Beneficiary: 8 discriminator + 32 estate. */
const BENEFICIARY_WALLET_OFFSET = 40;
/** Estate: 8 discriminator + owner + agent + usdt_mint, then verifiers 3×32. */
const VERIFIER_OFFSETS = [104, 136, 168] as const;

export interface EstateRole { estate: Base58; role: Extract<Role, "beneficiary" | "verifier" | "monitor"> }

/** Beneficiary roles first, then trusted person, then watcher: the last only for an estate with no other role. */
export async function estateRolesOf(wallet: Base58): Promise<EstateRole[]> {
  const me = new PublicKey(wallet);
  const named = async (type: string, offsets: readonly number[]): Promise<ProgramAccount[]> =>
    (await Promise.all(offsets.map((offset) => scanAccounts(type, [{ offset, key: me }]).catch(() => [])))).flat();
  const [beneficiaries, verifiers, seats, guards] = await Promise.all([
    named("Beneficiary", [BENEFICIARY_WALLET_OFFSET]),
    named("Estate", VERIFIER_OFFSETS),
    named("Seat", [...SEAT_BACKUP_OFFSETS, ...SEAT_MONITOR_OFFSETS]),
    named("Guard", GUARD_FALLBACK_OFFSETS),
  ]);

  const parent = (a: ProgramAccount) => new PublicKey(a.data.subarray(8, 40)).toBase58();
  const out: EstateRole[] = [];
  // Removed from the plan: the account stays, the role doesn't (R16).
  for (const b of beneficiaries) if (bool(decodeScanned("Beneficiary", b), "active")) out.push({ estate: parent(b), role: "beneficiary" });
  for (const v of verifiers) out.push({ estate: v.pubkey.toBase58(), role: "verifier" });
  for (const estate of new Set([...seats, ...guards].map(parent))) {
    if (!out.some((o) => o.estate === estate)) out.push({ estate, role: "monitor" });
  }
  return out;
}
