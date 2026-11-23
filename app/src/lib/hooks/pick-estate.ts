/**
 * Which estate the app opens for a wallet that belongs to several (bug 1, 22 Nov 2026), and the shareable listing
 * link (?estate=<address>, bug 16). Pure, so it is tested without React (pick-estate.test.ts).
 *
 * Order:
 *  1. a choice made in this visit (the estate switcher, or a ?estate= link) for this wallet and role. A link may
 *     name an estate the wallet has no role in (a buyer opening a listing); in chain mode it is opened anyway;
 *  2. the remembered estate (localStorage heirloom.lastEstate) if the wallet still belongs to it in the role it is
 *     signed in as (or no estate matches that role);
 *  3. the first estate where the wallet has the session's role ("Planning for my family" opens her own plan, a
 *     family member the estate she inherits from). The service lists the demo estate first, so judges land there;
 *  4. the first estate listed;
 *  5. chain mode with no estate at all: the remembered one (a buyer who opened a listing before).
 */
import type { Base58 } from "../types";

export interface EstateChoice { estate: Base58; role: string; ownerName: string }

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The estate a shared listing link names (`?estate=`), or null when absent or not an address. */
export function linkedEstate(search: string): Base58 | null {
  const v = new URLSearchParams(search).get("estate");
  return v && B58.test(v) ? v : null;
}

/** One entry per estate (a wallet can be a verifier and a beneficiary of the same estate): the first role listed. */
export function uniqueEstates(list: EstateChoice[]): EstateChoice[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.estate) ? false : (seen.add(x.estate), true)));
}

export function pickEstate(list: EstateChoice[], o: {
  /** A choice made in this visit (switcher or link), or null. */
  chosen: Base58 | null;
  /** True when `chosen` came from a link (it may be an estate the wallet has no role in). */
  chosenByLink?: boolean;
  remembered: Base58 | null;
  role: string | null;
  /** Chain mode: an estate outside the wallet's list can still be opened (a buyer's listing). */
  chain: boolean;
}): Base58 | null {
  const has = (e: Base58 | null) => !!e && list.some((x) => x.estate === e);
  if (o.chosen && (has(o.chosen) || (o.chosenByLink && o.chain))) return o.chosen;
  const inRole = o.role ? list.filter((x) => x.role === o.role) : [];
  if (has(o.remembered) && (!inRole.length || inRole.some((x) => x.estate === o.remembered))) return o.remembered;
  if (inRole.length) return inRole[0].estate;
  if (list.length) return list[0].estate;
  return o.chain ? o.remembered : null;
}

/** The listing link a seller shares with buyers: the page and the estate, on this site. */
export function listingLink(origin: string, estate: Base58, path = "/car"): string {
  return `${origin}${path}?estate=${encodeURIComponent(estate)}`;
}

/**
 * What /will shows (bug 2, generation 3): the signed plan only to its owner. Anyone else signed in as "Planning for
 * my family" is sent to her own plan if she has one, else offered the plan builder (a new estate in her wallet).
 */
export function willView(estateOwner: Base58 | null, me: Base58, estates: EstateChoice[], onScreen: Base58 | null):
  { kind: "builder" } | { kind: "locked" } | { kind: "openOwn"; estate: Base58 } | { kind: "startOwn" } {
  if (estateOwner === null) return { kind: "builder" };
  if (estateOwner === me) return { kind: "locked" };
  const own = estates.find((x) => x.role === "owner" && x.estate !== onScreen);
  return own ? { kind: "openOwn", estate: own.estate } : { kind: "startOwn" };
}
