import type { EstateSnapshot } from "../service/types";
import type { Base58 } from "../types";

/** The name this estate knows for the person who receives what is left. */
export function residualName(snap: Pick<EstateSnapshot, "beneficiaries" | "names">, wallet: Base58): string | null {
  return snap.beneficiaries.find((b) => b.wallet === wallet)?.label ?? snap.names?.[wallet] ?? null;
}
