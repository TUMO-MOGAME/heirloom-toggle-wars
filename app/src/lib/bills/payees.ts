/**
 * Saved bill payees (businesses and professionals) and the pieces both services share. Client-safe.
 * Payees live with the wallet that pays them (chain: this device's storage, per wallet; demo: the demo state),
 * never on-chain: they are an address book, not part of the plan.
 */
import { z } from "zod";
import type { Base58 } from "../types";
import { BILL_KINDS, type BillPayee, type BillPayeeInput } from "./types";
// The zod-free pieces live in ./book so the services (loaded on every first visit) need zod only when a bill is paid.
export { billActivityText, DEMO_BILL_PAYEES, payeesAsRecipients } from "./book";

const base58 = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "That is not a valid Solana address.");

export const billPayeeInputSchema = z.object({
  name: z.string().trim().min(2, "Give the payee a name.").max(64),
  wallet: base58,
  kind: z.enum(BILL_KINDS),
  reference: z.string().trim().max(40).optional().transform((v) => v || undefined),
});

export const billDetailsSchema = z.object({
  payee: z.string().trim().min(1).max(64),
  kind: z.enum(BILL_KINDS),
  reference: z.string().trim().max(40).nullable(),
  note: z.string().trim().max(120).nullable(),
  amountZar: z.number().positive().max(20_000_000).nullable(),
  invoiceSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  invoiceCheck: z.enum(["match", "mismatch", "unread"]).nullable(),
});

const id = () => `bp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Adds a payee, or updates the one with the same wallet (one entry per wallet). Returns the new list and the entry. */
export function upsertPayee(list: BillPayee[], input: BillPayeeInput): { list: BillPayee[]; payee: BillPayee } {
  const clean = billPayeeInputSchema.parse(input);
  const existing = list.find((p) => p.wallet === clean.wallet);
  const payee: BillPayee = { id: existing?.id ?? id(), ...clean };
  return { list: existing ? list.map((p) => (p.id === existing.id ? payee : p)) : [...list, payee], payee };
}

/* ---------- device store (chain mode) ---------- */

const KEY = "heirloom.billPayees.v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function billPayeeStore(storage: Storage | null = typeof window === "undefined" ? null : window.localStorage) {
  let memory: Record<Base58, BillPayee[]> = {};
  const read = (): Record<Base58, BillPayee[]> => {
    if (!storage) return memory;
    try { return JSON.parse(storage.getItem(KEY) ?? "{}") as Record<Base58, BillPayee[]>; } catch { return memory; }
  };
  const write = (all: Record<Base58, BillPayee[]>) => {
    memory = all;
    try { storage?.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: keep in memory */ }
  };
  return {
    list: (owner: Base58): BillPayee[] => read()[owner] ?? [],
    save(owner: Base58, input: BillPayeeInput): BillPayee {
      const all = read();
      const { list, payee } = upsertPayee(all[owner] ?? [], input);
      write({ ...all, [owner]: list });
      return payee;
    },
  };
}
