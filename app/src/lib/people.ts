/**
 * Who is who in an estate's activity feed, for display only (nothing here goes on-chain).
 *
 * Program events carry wallet addresses, never names, so on the devnet site an activity line reads
 * "Verifier 3Shi…o2at attested the death". The app often knows who that wallet is: the estate's own roles
 * (owner, trusted people and their backups and monitors, family, institutions, fallback recipients, buyers,
 * the agent, whose wallet also pays the network fees) and the wallets saved on this device. `nameBook()`
 * collects those names; `activityParts()` swaps each address in a line for the short form of the name
 * (lib/names), or keeps the short address when nobody is known, with the full address kept beside it.
 *
 * Demo (mock) lines already carry names and no `parties`, so they pass through unchanged: both modes
 * render through the same path (components/shell/activity-text.tsx).
 */
import { shortAddress } from "./format";
import { fullName, shortName } from "./names";
import type { EstateSnapshot } from "./service/types";
import type { ActivityItem, Base58 } from "./types";

/**
 * A wallet's display name: the full form ("Adv. Thandi Ndlovu", "University of Cape Town") and the one used in
 * sentences ("Adv. Ndlovu"; institutions, charities, the agent and device labels keep their full name).
 */
export interface KnownName { name: string; short: string }
/** Wallet address -> its display name. */
export type NameBook = ReadonlyMap<Base58, KnownName>;

export interface NameSources {
  /** Wallets saved on this device, with the label their owner gave them. Estate names win over these. */
  wallets?: readonly { address: Base58; label: string }[];
  /** The label for the estate's agent wallet (from content), e.g. "Heirloom's agent". */
  agentLabel?: string;
}

/** A name worth showing: not empty, not "Someone", and not just the address again. */
function usable(address: Base58, name: string | undefined | null): string | null {
  const n = fullName(name ?? "");
  if (!n || /^someone$/i.test(n) || n === address) return null;
  if (n.includes("…") && (n === shortAddress(address) || n === shortAddress(address, 6) || n === shortAddress(address, 8))) return null;
  return n;
}

/**
 * Every name the snapshot (and this device) knows, by wallet. The first source to name a wallet wins, in this
 * order: the owner, the trusted people (seat holders), the family, institutions, backups, monitors, fallback
 * recipients, disputers, buyers, the service's other off-chain names, the agent, then this device's wallet labels.
 */
export function nameBook(snap: EstateSnapshot | null | undefined, sources: NameSources = {}): NameBook {
  const book = new Map<Base58, KnownName>();
  /** `person`: shorten in sentences the way lib/names does; otherwise the full name every time. */
  const add = (address: Base58 | null | undefined, name: string | undefined | null, person = true) => {
    if (!address || book.has(address)) return;
    const n = usable(address, name);
    if (n) book.set(address, { name: n, short: person ? shortName(n) || n : n });
  };
  if (snap) {
    const e = snap.estate;
    add(e.owner, e.ownerName);
    const g = snap.guardians;
    for (const s of g?.seats ?? []) add(s.holder, s.holderName);
    e.verifiers.forEach((v, i) => add(v, e.verifierNames[i]));
    for (const b of snap.beneficiaries) add(b.wallet, b.label);
    for (const p of snap.payees) add(p.wallet, p.name, false);
    for (const s of g?.seats ?? []) {
      for (const b of s.backups) add(b.wallet, b.name);
      for (const m of s.monitors) add(m.wallet, m.name);
    }
    for (const o of g?.objections ?? []) add(o.monitor, o.monitorName);
    for (const f of g?.feed ?? []) add(f.approver, f.approverName);
    for (const r of g?.fallback.recipients ?? []) add(r.wallet, r.name, r.kind !== "charity");
    for (const d of snap.disputes ?? []) add(d.disputer, d.disputerName);
    for (const o of snap.offers) add(o.buyer, o.buyerName);
    for (const a of snap.activity) if (a.sale) add(a.sale.buyer, a.sale.buyerName);
    for (const [address, name] of Object.entries(snap.names ?? {})) add(address, name);
    add(e.agent, sources.agentLabel, false);
  }
  for (const w of sources.wallets ?? []) add(w.address, w.label, false);
  return book;
}

/** The form of the name used in sentences for `address`, or null when nobody is known. */
export function nameOf(book: NameBook, address: Base58 | null | undefined): string | null {
  return (address && book.get(address)?.short) || null;
}

/** A piece of an activity line: plain text, or a wallet with the name to show and its full address. */
export type ActivityPart = { text: string } | { text: string; address: Base58; named: boolean; full?: string };

/**
 * The line split around the wallets it names. Each wallet in `item.parties` appears in `item.text` as its short
 * address (lib/chain/events.ts); it becomes the person's short name when the book knows them.
 */
export function activityParts(item: Pick<ActivityItem, "text" | "parties">, book: NameBook): ActivityPart[] {
  const parties = [...new Set(item.parties ?? [])];
  if (parties.length === 0) return [{ text: item.text }];
  const byToken = new Map(parties.map((p) => [shortAddress(p), p] as const));
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const out: ActivityPart[] = [];
  for (const piece of item.text.split(new RegExp(`(${tokens.join("|")})`))) {
    if (!piece) continue;
    const address = byToken.get(piece);
    if (!address) { out.push({ text: piece }); continue; }
    const name = nameOf(book, address);
    out.push(name ? { text: name, address, named: true, full: book.get(address)?.name } : { text: piece, address, named: false });
  }
  return out;
}

/** The line as plain text, with names swapped in (for places that need a string). */
export function activityText(item: Pick<ActivityItem, "text" | "parties">, book: NameBook): string {
  return activityParts(item, book).map((p) => p.text).join("");
}
