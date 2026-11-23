/**
 * Why an offer can't be accepted yet, read from the ranking both services give (lib/agent/offers.ts, mock.ts rank):
 * on an estate with guardians an offer, or a hardship approval, waits out the objection window (`readyAt`), and an
 * offer made at or before an upheld objection to the sale is never accepted (OfferTooOld). The ranking's own reasons
 * are English, so the screens say these in the visitor's language. Pure.
 */
import type { Objection } from "../guardians/types";
import type { Base58, OfferRanking } from "../types";
import { LOCALE_TAGS, type Locale } from "../i18n/locales";

export type OfferWait =
  | { kind: "window"; readyAt: number; why: "offer" | "hardship" }
  | { kind: "tooOld" }
  | null;

export interface SaleWaitContext {
  asset: { address: Base58; hardshipBeneficiary: Base58 | null };
  /** The guardians' objections (snapshot.guardians.objections). */
  objections?: readonly Objection[];
  /** The Guard's objection window, or null without guardians. */
  windowSecs: number | null;
}

export function offerWait(ranking: OfferRanking | null, offer: { address: Base58; createdAt: number }, ctx: SaleWaitContext): OfferWait {
  const entry = ranking?.ineligible.find((x) => x.offer === offer.address);
  if (!entry) return null;
  if (entry.readyAt) {
    // Later than the offer's own window: the hardship approval's window is what it waits for.
    const own = ctx.windowSecs !== null ? offer.createdAt + ctx.windowSecs : 0;
    return { kind: "window", readyAt: entry.readyAt, why: ctx.asset.hardshipBeneficiary && entry.readyAt > own ? "hardship" : "offer" };
  }
  const upheld = ctx.objections?.find((o) => o.kind === "Sale" && o.target === ctx.asset.address && o.status === "Upheld");
  return upheld && offer.createdAt <= upheld.raisedAt ? { kind: "tooOld" } : null;
}

/** When the next waiting offer becomes acceptable (the ranking is read again then), or null. */
export function nextReadyAt(ranking: OfferRanking | null): number | null {
  const at = ranking?.ineligible.flatMap((x) => (x.readyAt ? [x.readyAt] : [])) ?? [];
  return at.length ? Math.min(...at) : null;
}

/** With no offer acceptable now: the highest one that only waits for its window (ties: the sooner). */
export function bestWaiting(ranking: OfferRanking | null): { offer: Base58; amount: bigint; readyAt: number } | null {
  let best: { offer: Base58; amount: bigint; readyAt: number } | null = null;
  for (const x of ranking?.ineligible ?? []) {
    if (!x.readyAt) continue;
    if (!best || x.amount > best.amount || (x.amount === best.amount && x.readyAt < best.readyAt)) best = { offer: x.offer, amount: x.amount, readyAt: x.readyAt };
  }
  return best;
}

/**
 * "14:06" (the next whole minute, so it is never early), with the weekday when it isn't today, or the date when it is
 * a week or more away, in the visitor's language and time zone.
 */
export function clockTime(at: number, now: number, locale: Locale): string {
  const d = new Date(Math.ceil(at / 60) * 60_000);
  const sameDay = d.toDateString() === new Date(now * 1000).toDateString();
  const far = at - now >= 6 * 86_400;
  const day: Intl.DateTimeFormatOptions = far ? { day: "numeric", month: "short", year: "numeric" } : sameDay ? {} : { weekday: "short" };
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false, ...day };
  try { return new Intl.DateTimeFormat(LOCALE_TAGS[locale], opts).format(d); } catch { return new Intl.DateTimeFormat("en-ZA", opts).format(d); }
}
