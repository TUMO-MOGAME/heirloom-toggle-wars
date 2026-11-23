/**
 * Plain words for letters (shared by the page, the moment card, the tree card line and the plan card): dates in
 * South African time, the opening state, names, and the seeded demo letters in the visitor's language.
 */
import type { LettersCopy } from "@/content/letters";
import type { EstateSnapshot } from "@/lib/service";
import type { Base58 } from "@/lib/types";
import type { Locale } from "@/lib/i18n/locales";
import { shortName } from "@/lib/names";
import type { LetterView } from "@/lib/letters/types";

export type Copy = LettersCopy;

export function fill(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const intl = (l: Locale) => (l === "af" ? "af-ZA" : l === "zu" ? "zu-ZA" : "en-ZA");
/** "14 Aug 2029" in South African time. */
export function dateText(ts: number, locale: Locale): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", year: "numeric" };
  try { return new Intl.DateTimeFormat(intl(locale), opts).format(ts * 1000); } catch { return new Intl.DateTimeFormat("en-ZA", opts).format(ts * 1000); }
}

export const usdt = (n: number) => `${n.toLocaleString("en-ZA", { maximumFractionDigits: 2 })} USD₮`;

/** A person's short name from the estate ("Lerato"), or a short address. */
export function nameOf(snap: EstateSnapshot, wallet: Base58): string {
  const label = snap.beneficiaries.find((b) => b.wallet === wallet)?.label ?? snap.names?.[wallet] ?? (wallet === snap.estate.owner ? snap.estate.ownerName : "");
  return label ? shortName(label.replace(/\s*\(.*\)$/, "")) : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

export const recipientText = (l: Pick<LetterView, "to">, snap: EstateSnapshot, copy: Copy) => (l.to.kind === "family" ? copy.list.family : nameOf(snap, l.to.wallet));

/** A seeded demo letter shows in the visitor's language until the owner changes it. */
export function letterWords(l: LetterView, copy: Copy): { occasion: string; text: string } {
  if (l.demoKey && l.version === 1 && !l.sig) return copy.demo[l.demoKey];
  return { occasion: l.occasion, text: l.text };
}

/** "Opens when the estate unlocks", "Opens on 14 Aug 2029", "Opens with Naledi's gift, 500 USD₮, due 14 Aug 2029", "Opened …". */
export function stateText(l: LetterView, snap: EstateSnapshot, copy: Copy, locale: Locale): string {
  if (l.state === "open") return fill(copy.state.opened, { date: l.openedAt ? dateText(l.openedAt, locale) : "" });
  const o = l.opens;
  if (o.kind === "unlock") return copy.state.unlock;
  if (o.kind === "date") return fill(copy.state.date, { date: l.hint.on ? dateText(l.hint.on, locale) : o.on });
  if (o.kind === "send") return copy.state.send;
  const name = l.to.kind === "person" ? nameOf(snap, l.to.wallet) : "";
  const amount = l.hint.giftUsdt !== undefined ? usdt(l.hint.giftUsdt) : "";
  // A claim rule has no set amount until it pays: say only that it opens with the next payment.
  if (!amount) return fill(copy.state.paymentNext, { name });
  return l.hint.on ? fill(copy.state.payment, { name, amount, date: dateText(l.hint.on, locale) }) : fill(copy.state.paymentNoDate, { name, amount });
}
