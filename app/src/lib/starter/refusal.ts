/** What the starter banner says after a no: always when to try again, or where else to get test SOL. Pure. */
import type { ContinuityCopy } from "@/content/continuity";

export const FAUCET_URL = "https://faucet.solana.com";

const DAY_MS = 86_400_000;
/** When a refusal carried no time. */
const DEFAULT_WAIT_SECS: Record<string, number> = { hourly_cap: 3_600, daily_cap: 86_400, rate_limited: 60, busy: 60 };

export interface RefusalText {
  text: string;
  /** Show the faucet line and link under it. */
  faucet: boolean;
}

/** The clock time to try again, with the weekday when it isn't today. */
export function retryTime(now: number, secs: number): string {
  // The next whole minute, so "try again at 14:05" is never a few seconds early.
  const at = new Date(Math.ceil((now + secs * 1000) / 60_000) * 60_000);
  const sameDay = secs * 1000 < DAY_MS && at.getDate() === new Date(now).getDate();
  return at.toLocaleString([], { hour: "2-digit", minute: "2-digit", hour12: false, ...(sameDay ? {} : { weekday: "short" }) });
}

export function starterRefusalText(
  copy: ContinuityCopy["starter"], refusal: { code?: string; retryAfterSecs?: number }, now: number,
): RefusalText {
  const code = refusal.code ?? "failed";
  const r = copy.refused;
  if (code in DEFAULT_WAIT_SECS) {
    const text = code === "hourly_cap" ? r.hourlyCap : code === "daily_cap" ? r.dailyCap : code === "busy" ? r.busy : r.rateLimited;
    return { text: text.replace("{time}", retryTime(now, refusal.retryAfterSecs ?? DEFAULT_WAIT_SECS[code])), faucet: true };
  }
  if (code === "already_funded") return { text: r.alreadyFunded, faucet: true };
  if (code === "empty") return { text: r.empty, faucet: true };
  if (code === "unavailable") return { text: r.unavailable, faucet: true };
  return { text: r.failed, faucet: true };
}
