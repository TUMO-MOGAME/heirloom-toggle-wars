/**
 * The plan being signed, kept on the owner's device before the first transaction (plan §18.9 H6). Signing a plan on
 * Solana takes several transactions; if the page closes, the network drops or a practice top-up fails half way, the
 * owner finishes from this copy instead of losing the names and the rules that hadn't landed yet. It stays after
 * signing (marked done) so the screens can say what each schedule was chosen as (H10) and prefill the planned asset (M4).
 * Personal data on the owner's own device only, like the names copy (lib/estate-meta/keeper.ts). Never on-chain.
 */
import type { Base58, Recurrence, Rule, WillDraft } from "../types";
import type { CreateEstateOptions } from "../continuity/types";
import { toBase } from "../format";

const KEY = "heirloom.signing.v1";

export interface SigningRecord {
  owner: Base58;
  draft: WillDraft;
  options: CreateEstateOptions;
  /** All of it is on-chain. */
  done: boolean;
  at: number;
}

type Store = Pick<Storage, "getItem" | "setItem">;
const browser = (): Store | null => { try { return (globalThis as { localStorage?: Store }).localStorage ?? null; } catch { return null; } };

export function createSigningStore(storage: () => Store | null = browser) {
  const all = (): Record<Base58, SigningRecord> => {
    try { const v: unknown = JSON.parse(storage()?.getItem(KEY) ?? "{}"); return v && typeof v === "object" ? (v as Record<Base58, SigningRecord>) : {}; } catch { return {}; }
  };
  const write = (next: Record<Base58, SigningRecord>) => { try { storage()?.setItem(KEY, JSON.stringify(next)); } catch { /* full or blocked */ } };
  return {
    get(estate: Base58, owner: Base58): SigningRecord | null {
      const r = all()[estate];
      return r && r.owner === owner && r.draft ? r : null;
    },
    put(estate: Base58, r: Omit<SigningRecord, "at">) { write({ ...all(), [estate]: { ...r, at: Date.now() } }); },
    done(estate: Base58) { const a = all(); if (a[estate]) write({ ...a, [estate]: { ...a[estate], done: true } }); },
  };
}

/** The interval each signed schedule was chosen as, from the plan this device signed (the chain keeps only seconds). */
export function withChosenEvery(rules: Rule[], draft: WillDraft | null | undefined): Rule[] {
  if (!draft) return rules;
  return rules.map((r) => {
    if (r.every || r.recurringAmount === BigInt(0)) return r;
    const wallet = (label: string) => draft.beneficiaries.find((b) => b.label === label)?.wallet;
    const hit = draft.rules.find((d) => d.recurring && wallet(d.beneficiaryLabel) === r.beneficiary && d.category === r.category
      && toBase(d.recurring.amountUsdt) === r.recurringAmount && Math.floor(Date.parse(d.validUntil) / 1000) === r.validUntil);
    return hit?.recurring ? { ...r, every: hit.recurring.every as Recurrence } : r;
  });
}
