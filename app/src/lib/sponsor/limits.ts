/**
 * The fee sponsor's limits: per-wallet sliding windows (per minute, per day), sponsored-rent creations per wallet
 * per day, a day's fees and rent per network address, and a daily lamport budget for the whole sponsor.
 * `SponsorLimiter` holds them on this instance; `sharedTakes` are the same across instances when the shared store is
 * there.
 *
 * A transaction is charged to every signer it has (the policy refuses signers nothing needs, so these are its real
 * actors) and to the estate of any permissionless instruction in it (plan §18.9 H3): a throwaway signer gives no fresh
 * allowance. Its keys are taken all together or not at all.
 */
import type { Take } from "../server/shared-store";
import { TOKEN_ACCOUNT_RENT } from "./policy";
export interface SponsorLimits {
  perMinute: number; perDay: number; rentPerDay: number; dailyBudgetLamports: number;
  /** One network address, a day: sponsored transactions and sponsored new accounts. */
  ipFeesPerDay: number; ipRentPerDay: number;
}

/**
 * Sized for a room of judges behind one address (room.test.ts has the arithmetic). One address can use two thirds of
 * the day's fees and 90 of its 102 new accounts, never all of either.
 */
export const DEFAULT_SPONSOR_LIMITS: SponsorLimits = {
  perMinute: 20, perDay: 100, rentPerDay: 3, dailyBudgetLamports: 300_000_000, ipFeesPerDay: 3_000, ipRentPerDay: 90,
};
/** /api/sponsor, for each IP address: one Wi-Fi is one address. */
export const SPONSOR_PER_IP_MINUTE = 90;

const MIN = 60_000, DAY = 86_400_000;

const MINUTE_SECS = 60, DAY_SECS = 86_400;
/** The shared store counts, it can't add up lamports: this much of the day's budget is for rent, the rest for fees. */
const RENT_SHARE = 0.7;

const keysOf = (who: string | readonly string[]) => [...new Set(typeof who === "string" ? [who] : who)];

/**
 * The shared allowances for one sponsored transaction. Their worst case stays within the daily budget: a fee is at
 * most `maxFeeLamports`, and the policy sponsors rent for one account at most (a token account is the dearer).
 */
export function sharedTakes(who: string | readonly string[], rent: boolean, limits: SponsorLimits, maxFeeLamports: number, ip?: string): Take[] {
  const forRent = Math.floor(limits.dailyBudgetLamports * RENT_SHARE);
  const atLeastOne = (n: number) => Math.max(1, Math.floor(n)); // the store refuses a limit of 0
  const wallets = keysOf(who);
  const takes: Take[] = [
    ...wallets.flatMap((w) => [
      { key: `sponsor:minute:${w}`, max: atLeastOne(limits.perMinute), windowSecs: MINUTE_SECS },
      { key: `sponsor:day:${w}`, max: atLeastOne(limits.perDay), windowSecs: DAY_SECS },
    ]),
    { key: "sponsor:fees", max: atLeastOne((limits.dailyBudgetLamports - forRent) / Math.max(1, maxFeeLamports)), windowSecs: DAY_SECS },
    ...(ip === undefined ? [] : [{ key: `sponsor:ip:fees:${ip}`, max: atLeastOne(limits.ipFeesPerDay), windowSecs: DAY_SECS }]),
  ];
  if (rent) {
    takes.push(
      ...wallets.map((w) => ({ key: `sponsor:rent:${w}`, max: atLeastOne(limits.rentPerDay), windowSecs: DAY_SECS })),
      { key: "sponsor:rent", max: atLeastOne(forRent / TOKEN_ACCOUNT_RENT), windowSecs: DAY_SECS },
      ...(ip === undefined ? [] : [{ key: `sponsor:ip:rent:${ip}`, max: atLeastOne(limits.ipRentPerDay), windowSecs: DAY_SECS }]),
    );
  }
  return takes;
}

export class SponsorLimiter {
  private hits = new Map<string, number[]>();
  private rent = new Map<string, number[]>();
  private spent: { at: number; lamports: number }[] = [];
  constructor(private limits: SponsorLimits = DEFAULT_SPONSOR_LIMITS) {}

  /** What is still inside the window. Stores nothing for a key with nothing recorded, so refusals use no memory. */
  private recent(m: Map<string, number[]>, key: string, now: number, window: number): number[] {
    const held = m.get(key);
    if (!held) return [];
    const xs = held.filter((t) => now - t < window);
    if (xs.length) m.set(key, xs); else m.delete(key);
    return xs;
  }

  /** Returns a reason string when the request must be refused; null when it may proceed. Does not record. */
  check(who: string | readonly string[], lamports: number, rent: boolean, now = Date.now(), ip?: string): string | null {
    for (const wallet of keysOf(who)) {
      const day = this.recent(this.hits, wallet, now, DAY);
      if (day.filter((t) => now - t < MIN).length >= this.limits.perMinute) return "Too many sponsored transactions from this wallet. Please wait a minute.";
      if (day.length >= this.limits.perDay) return "This wallet reached today's limit of sponsored transactions.";
      if (rent && this.recent(this.rent, wallet, now, DAY).length >= this.limits.rentPerDay) return "This wallet reached today's limit of sponsored new accounts.";
    }
    if (ip !== undefined) {
      if (this.recent(this.hits, `ip:${ip}`, now, DAY).length >= this.limits.ipFeesPerDay) return "This network reached today's limit of sponsored transactions.";
      if (rent && this.recent(this.rent, `ip:${ip}`, now, DAY).length >= this.limits.ipRentPerDay) return "This network reached today's limit of sponsored new accounts.";
    }
    this.spent = this.spent.filter((s) => now - s.at < DAY);
    const used = this.spent.reduce((a, s) => a + s.lamports, 0);
    if (used + lamports > this.limits.dailyBudgetLamports) return "The fee sponsor's daily budget is used up.";
    return null;
  }

  private keys(who: string | readonly string[], ip?: string) {
    return [...keysOf(who), ...(ip === undefined ? [] : [`ip:${ip}`])];
  }

  /** Gives back what `record` took at `now`: nothing was signed after all. */
  refund(who: string | readonly string[], lamports: number, rent: boolean, now: number, ip?: string): void {
    const drop = (m: Map<string, number[]>, key: string) => {
      const list = m.get(key);
      const at = list?.lastIndexOf(now) ?? -1;
      if (at >= 0) list!.splice(at, 1);
      if (list && !list.length) m.delete(key);
    };
    for (const key of this.keys(who, ip)) {
      drop(this.hits, key);
      if (rent) drop(this.rent, key);
    }
    const at = this.spent.findIndex((s) => s.at === now && s.lamports === lamports);
    if (at >= 0) this.spent.splice(at, 1);
  }

  record(who: string | readonly string[], lamports: number, rent: boolean, now = Date.now(), ip?: string): void {
    const push = (m: Map<string, number[]>, key: string) => m.set(key, [...this.recent(m, key, now, DAY), now]);
    for (const key of this.keys(who, ip)) {
      push(this.hits, key);
      if (rent) push(this.rent, key);
    }
    this.spent.push({ at: now, lamports });
    // Entries only come from transactions the budget let through, so this stays small; expired ones go, none early.
    if (this.hits.size > 50_000) for (const key of [...this.hits.keys()]) this.recent(this.hits, key, now, DAY);
    if (this.rent.size > 50_000) for (const key of [...this.rent.keys()]) this.recent(this.rent, key, now, DAY);
  }
}
