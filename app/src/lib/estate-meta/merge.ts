/**
 * Merging two copies of an estate's off-chain names (plan §18.3 S4). Pure, shared by the server and the browser.
 * A role written in place of a name ("Estate owner", "Verifier 2": what non-members are shown) counts as no name.
 */
import type { EstateMeta } from "../db";

export type Names = Pick<EstateMeta, "ownerName" | "verifierNames" | "assetTitles" | "buyerNames">;

export const OWNER_ROLE = "Estate owner";
export const verifierRole = (index: number) => `Verifier ${index + 1}`;

const noOwner = (name: string) => !name || name === OWNER_ROLE;
const noVerifier = (name: string | undefined, index: number) => !name || name === verifierRole(index);

export const namesOf = (m: Names): Names => ({
  ownerName: m.ownerName, verifierNames: m.verifierNames, assetTitles: m.assetTitles, buyerNames: m.buyerNames,
});

/** True when there is at least one real name or title in it. */
export function hasNames(m: Names): boolean {
  return !noOwner(m.ownerName) || m.verifierNames.some((n, i) => !noVerifier(n, i))
    || Object.keys(m.assetTitles).length > 0 || Object.keys(m.buyerNames).length > 0;
}

/** `from` supplies only what `into` lacks: a value already there is never replaced. */
export function fillGaps(into: Names | null, from: Names): { names: Names; changed: boolean } {
  if (!into) return { names: namesOf(from), changed: true };
  let changed = false;
  let ownerName = into.ownerName;
  if (noOwner(ownerName) && !noOwner(from.ownerName)) {
    ownerName = from.ownerName;
    changed = true;
  }
  const verifierNames = into.verifierNames.map((name, i) => {
    if (!noVerifier(name, i) || noVerifier(from.verifierNames[i], i)) return name;
    changed = true;
    return from.verifierNames[i];
  }) as Names["verifierNames"];
  const fill = (have: Record<string, string>, more: Record<string, string>) => {
    const out = { ...have };
    for (const [key, value] of Object.entries(more)) {
      if (!value || out[key]) continue;
      out[key] = value;
      changed = true;
    }
    return out;
  };
  const assetTitles = fill(into.assetTitles, from.assetTitles);
  const buyerNames = fill(into.buyerNames, from.buyerNames);
  return { names: { ownerName, verifierNames, assetTitles, buyerNames }, changed };
}

/** Both copies together: where they disagree the newer wins, and a tie goes to `a`. */
export function newestNames(a: { names: Names; at: number }, b: { names: Names; at: number }): Names {
  return b.at > a.at ? fillGaps(b.names, a.names).names : fillGaps(a.names, b.names).names;
}
