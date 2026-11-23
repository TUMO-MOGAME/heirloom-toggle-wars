/**
 * Pay a bill once (plan.md §13.2): the owner pays a one-off bill (a lawyer, a plumber, a school trip) from their own
 * Tether WDK wallet, through the same review → approve → pending → confirmed flow as any send. Never from the vault:
 * the vault only pays by the plan's rules. Client-safe types, no imports beyond the shared Base58 alias.
 */
import type { Base58, PaymentStatus } from "../types";

export const BILL_KINDS = ["lawyer", "plumber", "school", "doctor", "builder", "other"] as const;
export type BillKind = (typeof BILL_KINDS)[number];

/** A business or professional the owner pays now and then. Kept off-chain (device or demo state), never in the estate. */
export interface BillPayee {
  id: string;
  name: string;
  wallet: Base58;
  kind: BillKind;
  /** The owner's client or account number with this payee, prefilled as the bill's reference. */
  reference?: string;
}
export type BillPayeeInput = Omit<BillPayee, "id">;

/** How the invoice compared with what was typed (lib/bills/invoice.ts compareInvoice). */
export type InvoiceCheck = "match" | "mismatch" | "unread";

/** What a bill payment carries beside the plain transfer: shown on the review, the receipt and the activity line. */
export interface BillDetails {
  payee: string;
  kind: BillKind;
  reference: string | null;
  /** What it is for ("Drafting the will"). */
  note: string | null;
  /** The rand amount the owner typed, if they typed rand (the transfer itself is in USD₮). */
  amountZar: number | null;
  /** SHA-256 of the invoice the AI read, if any. The file itself is never stored. */
  invoiceSha256: string | null;
  invoiceCheck: InvoiceCheck | null;
}

/** A bill paid (or still pending) from this wallet, newest first. */
export interface PaidBill {
  id: string;
  to: Base58;
  bill: BillDetails;
  amount: bigint;
  status: PaymentStatus;
  signature?: string;
  explorerUrl?: string;
  /** Unix seconds. */
  ts: number;
}
