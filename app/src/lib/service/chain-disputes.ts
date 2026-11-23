/**
 * DisputesService on Solana (docs/program-spec.md, "Disputes and yearly caps"). Writes go through chain.ts's pay-once
 * pipeline (fee sponsored: raise_dispute, resolve_dispute and set_yearly_cap are on the sponsor's allow-list).
 * The written reason stays on this device; only its SHA-256 goes on-chain.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { Base58, Estate, Rule } from "../types";
import type { Dispute, DisputesService } from "../disputes/types";
import type { TxResult } from "./types";
import { chainCtx } from "../chain/client";
import * as ix from "../chain/instructions";
import { fetchAccountRaw } from "../chain/reads";
import { assembleDisputes, fetchDisputesRaw } from "../chain/disputes";
import { enumOf, key } from "../chain/decoders";
import { getActiveSigner } from "../wallet/signer";
import { sha256Hex } from "../agent/hash";
import { toBase } from "../format";
import { saveReason } from "../disputes/reasons-client";

type Ixs = TransactionInstruction[] | ((feePayer: PublicKey) => TransactionInstruction[]);

export interface ChainDisputeDeps {
  send(ixs: Ixs): Promise<TxResult>;
  requireOwnerOf(estate: Base58): PublicKey;
}

const pk = (a: string) => new PublicKey(a);
const KINDS = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"] as const;

/* ---------- device-local reasons (only the hash is on-chain) ---------- */
const LOCAL_KEY = "heirloom.disputes.reasons.v1";
function reasons(): Record<string, string> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(LOCAL_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}
function remember(hash: string, text: string) {
  try { if (typeof window !== "undefined") window.localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...reasons(), [hash]: text })); } catch { /* ignore */ }
}

/** The estate's disputes and its rules with their yearly caps (used by chain.ts getEstate). */
export async function loadDisputes(estate: Base58, base: { estate: Estate; rules: Rule[] }, names: Record<Base58, string>, shared: Record<string, string> = {}): Promise<{ disputes: Dispute[]; rules: Rule[] }> {
  const raw = await fetchDisputesRaw(estate, base.rules.map((r) => r.address));
  // The family's saved reasons (M9, already checked against their hashes), then this device's own.
  return assembleDisputes(raw, { ...base, names, reasons: { ...shared, ...reasons() } });
}

export function createChainDisputes(d: ChainDisputeDeps): DisputesService {
  const me = () => pk(getActiveSigner().address);
  return {
    async raiseDispute(estate, input) {
      const reason = input.reason.trim();
      if (!reason) throw new Error("Write a short reason.");
      const e = await fetchAccountRaw("Estate", estate);
      if (!e) throw new Error("That estate was not found.");
      const disputer = me();
      const verifiers = (e.verifiers as unknown[]).map((v) => (typeof v === "string" ? v : (v as { toBase58(): string }).toBase58()));
      const reasonHashHex = await sha256Hex(reason);
      remember(reasonHashHex, reason);
      const tx = await d.send([ix.raiseDispute(chainCtx(), {
        disputer, estate: pk(estate), kind: input.kind, target: pk(input.target), reasonHashHex,
        // A trusted person disputes as a verifier; anyone else as a beneficiary (the program checks either way).
        beneficiary: !verifiers.includes(disputer.toBase58()),
      })]);
      // Once it is on-chain, the words go where the people who vote can read them (M9); this device keeps its copy.
      await saveReason(getActiveSigner(), estate, input.target, reason).catch((e: unknown) => console.warn(`The reason was kept on this device only: ${(e as Error).message}`));
      return tx;
    },

    async resolveDispute(estate, dispute, uphold) {
      const o = await fetchAccountRaw("Objection", dispute);
      if (!o) throw new Error("That dispute was not found.");
      const kind = enumOf(o, "kind", KINDS);
      if (kind !== "Claim" && kind !== "Unlock") throw new Error("That is not a dispute.");
      return d.send([ix.resolveDispute(chainCtx(), { verifier: me(), estate: pk(estate), kind, target: pk(key(o, "target")), uphold })]);
    },

    async setYearlyCap(estate, rule, input) {
      const owner = d.requireOwnerOf(estate);
      return d.send([ix.setYearlyCap(chainCtx(), { owner, rule: pk(rule), cap: toBase(input.capUsdt), periodStart: input.periodStart ?? 0 })]);
    },
  };
}
