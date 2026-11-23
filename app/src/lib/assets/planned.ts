/**
 * The assets a signed plan describes (M4). Signing records the plan's fingerprint but registers no asset: the owner
 * adds each one under Assets, where the plan's prices and its choice of who gets the sale money are filled in.
 */
import type { Asset, Base58, Beneficiary, WillDraft } from "../types";

type Planned = WillDraft["assets"][number];

/** The first planned asset not on the estate yet (by its name). */
export function nextPlanned(planned: readonly Planned[] | undefined, assets: readonly Pick<Asset, "title">[]): Planned | null {
  return planned?.find((p) => !assets.some((a) => a.title.trim().toLowerCase() === p.title.trim().toLowerCase())) ?? null;
}

const VAULT = /\b(vault|kluis|polokelo|isisefo)\b/i;

/**
 * Who the plan's words send the money to ("The family vault, to fund the children's rules", "Lerato", a wallet): the
 * estate's vault, one family member, or null when it isn't clear (the owner then chooses).
 */
export function proceedsFromPlan(text: string, estate: Base58, family: readonly Pick<Beneficiary, "wallet" | "label" | "active">[]): Base58 | null {
  const t = text.trim();
  if (!t) return null;
  const live = family.filter((b) => b.active);
  const byWallet = live.find((b) => b.wallet === t);
  if (byWallet) return byWallet.wallet;
  if (VAULT.test(t)) return estate;
  const first = (label: string) => label.split(/[ (]/)[0].toLowerCase();
  const named = live.filter((b) => first(b.label).length > 1 && new RegExp(`(^|[^\p{L}])${first(b.label)}($|[^\p{L}])`, "iu").test(t));
  return named.length === 1 ? named[0].wallet : null;
}
