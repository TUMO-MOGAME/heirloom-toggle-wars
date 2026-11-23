/**
 * The handover pack after an asset is sold: the sale's facts (from the AssetSold record) and who may open it.
 * The seller side is the estate's people: the owner, the trusted people (the executor is one) and the family.
 */
import type { EstateSnapshot } from "../service/types";
import type { AssetKind } from "../guardians/types";
import type { Base58, HexHash } from "../types";

export interface SaleFacts {
  asset: Base58;
  amount: bigint | null;
  ts: number;
  txSignature: string | null;
  buyer: Base58 | null;
  buyerName: string | null;
  recipient: Base58 | null;
  hardship: boolean;
}

/**
 * The sale of one asset. Prefers the record that names the asset (AssetSold events carry it); a demo saved before
 * sale records existed falls back to the only AssetSold line, when exactly one asset has been sold.
 */
export function saleOf(snap: EstateSnapshot, asset: Base58): SaleFacts | null {
  const a = snap.assets.find((x) => x.address === asset);
  if (!a || a.status !== "Sold") return null;
  const sold = snap.activity.filter((x) => x.kind === "AssetSold");
  const named = sold.find((x) => x.sale?.asset === asset);
  const onlyOne = snap.assets.filter((x) => x.status === "Sold").length === 1;
  const item = named ?? (onlyOne ? sold.find((x) => !x.sale) : undefined);
  if (!item) return null;
  return {
    asset,
    amount: item.amount ?? null,
    ts: item.ts,
    txSignature: item.txSignature ?? null,
    buyer: item.sale?.buyer ?? null,
    buyerName: item.sale?.buyerName ?? null,
    recipient: item.sale?.recipient ?? null,
    hardship: item.sale?.hardship ?? !!a.hardshipBeneficiary,
  };
}

/** The owner, a trusted person or a named family member of this estate. */
export function isSellerSide(snap: EstateSnapshot, wallet: Base58): boolean {
  const e = snap.estate;
  return wallet === e.owner || e.verifiers.includes(wallet) || snap.beneficiaries.some((b) => b.wallet === wallet && b.active);
}

/** Road vehicles get the licensing-office steps (change of ownership); other kinds a plain handover note. */
export const isVehicle = (kind: AssetKind) => kind === "Car" || kind === "Motorbike";

/** A document fingerprint that was actually recorded (a zero hash means none). */
export const recordedHash = (h: HexHash | null | undefined): HexHash | null => (h && !/^0+$/.test(h) ? h : null);
