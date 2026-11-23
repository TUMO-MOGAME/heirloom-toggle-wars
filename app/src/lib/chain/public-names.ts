/**
 * What may be written to the public, permanent ledger in place of a name (POPIA; CLAUDE.md: never personal data
 * on-chain). `add_beneficiary` and `add_payee` take a text label, so the app writes a role there and keeps the real
 * name off-chain with the estate's names (members only, lib/access) and on the owner's device.
 *
 * Universities and schools keep their public names: they are institutions, not people, and the public record should
 * show where the money went. Landlords and other payees are often people, so they never do.
 */
import type { Base58, Beneficiary, Payee, PayeeKind } from "../types";

export const publicBeneficiaryLabel = (index: number): string => `Family member ${index + 1}`;

export function publicPayeeName(p: { name: string; kind: PayeeKind; wallet: Base58 }, family: ReadonlySet<Base58>): string {
  if (family.has(p.wallet)) return "Family member's own wallet";
  if (p.kind === "Landlord") return "Approved landlord";
  if (p.kind === "Other") return "Approved payee";
  return p.name.trim().slice(0, 64);
}

const ROLE_ONLY = /^(Family member \d+|Family member's own wallet|Approved landlord|Approved payee)$/;

/** True for a label this file wrote: the real name, if known, is off-chain. */
export const isRoleOnly = (label: string): boolean => ROLE_ONLY.test(label);

/** Puts the family's own names back for display. Names recorded on-chain by older estates are left as they are. */
export function withPrivateNames<T extends { beneficiaries: Beneficiary[]; payees: Payee[] }>(snap: T, names: Record<Base58, string>): T {
  return {
    ...snap,
    beneficiaries: snap.beneficiaries.map((b) => (isRoleOnly(b.label) && names[b.wallet] ? { ...b, label: names[b.wallet] } : b)),
    payees: snap.payees.map((p) => {
      if (!isRoleOnly(p.name) || !names[p.wallet]) return p;
      const own = p.name === "Family member's own wallet";
      return { ...p, name: own ? `${names[p.wallet].split(/[ (]/)[0]}'s own wallet` : names[p.wallet] };
    }),
  };
}
