/**
 * Bill payee helpers that need no validation library: the demo address book, the assistant's view of it and the
 * activity line. Re-exported by ./payees (which adds the zod schemas and the device store).
 */
import type { BillDetails, BillPayee } from "./types";
import type { RecipientLike } from "../assistant/intent";

/** Bill payees as the wallet assistant's recipients: "Pay Ndlovu Attorneys R2 500" finds them by name or by kind. */
export function payeesAsRecipients(list: BillPayee[]): RecipientLike[] {
  return list.map((p) => ({ label: p.name, address: p.wallet, relationship: p.kind }));
}

/** One activity line, the same in both modes. */
export function billActivityText(payer: string, bill: BillDetails, amount: string): string {
  const what = [bill.note, bill.reference ? `ref ${bill.reference}` : null].filter(Boolean).join(", ");
  return `${payer} paid a bill: ${amount} to ${bill.payee}${what ? ` (${what})` : ""}`;
}

/** Thabo's saved payees in the demo: his lawyer (the will), his plumber and Naledi's school. */
export const DEMO_BILL_PAYEES: BillPayee[] = [
  { id: "bp_ndlovu", name: "Ndlovu Attorneys", wallet: "NdLoVuAtToRnEyS2wiLLdRaFtiNg8uE6rAoPaYbiLL1", kind: "lawyer" },
  { id: "bp_plumber", name: "Soweto Plumbing", wallet: "SoWeToPLuMbiNg3PiPeSaNdGeYsERs8uE6rAoPaYbiL2", kind: "plumber" },
  { id: "bp_school", name: "Westerford High School", wallet: "WeSTeRFoRdHiGhSchooLTRiPs4uE6rAoPaYbiLL3xyz", kind: "school", reference: "NALEDI-M" },
];
