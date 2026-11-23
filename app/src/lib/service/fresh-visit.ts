/**
 * A first visit to the demo: nothing saved in this browser (no simulated estate, no chosen persona), no
 * "?demo=<stage>" link and English. Such a visitor is certainly Thabo with no estate yet, so the app can show that
 * first screen from the server-rendered HTML instead of waiting for its JavaScript (a slow phone notices).
 *
 * Two forms of the same check, kept in step by fresh-visit.test.ts:
 *   - FRESH_DEMO_PREPAINT, run inline before the first paint (root layout), marks <html data-fresh>; CSS then shows
 *     the server-rendered first screen (Gate's `fresh-only` block) instead of the loading frame;
 *   - isFreshDemoVisit(), for the browser code (EstateProvider skips the wait for the demo service).
 * Demo (mock) builds only; chain mode never marks a visit as fresh.
 */
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, LOCALES } from "../i18n/locales";
import { ACTIVE_WALLET_KEY } from "../wallet/store";
import { personaSessions } from "../wallet/personas";
import type { WalletSession } from "../types";
import { MOCK_STORE_KEY } from "./is-mock";

/** The `<html>` attribute (data-fresh) the pre-paint script sets. */
export const FRESH_ATTR = "data-fresh";

const locales = JSON.stringify(LOCALES);

/** Inline script body (inside the root layout's try/catch; `l` = localStorage, `d` = documentElement). */
export const FRESH_DEMO_PREPAINT =
  `var fq=new URLSearchParams(location.search),fl=fq.get("lang"),fs=l.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)}),fk=${locales};` +
  `if(!l.getItem(${JSON.stringify(MOCK_STORE_KEY)})&&!l.getItem(${JSON.stringify(ACTIVE_WALLET_KEY)})&&!fq.has("demo")` +
  `&&(fk.indexOf(fl)>=0?fl:fk.indexOf(fs)>=0?fs:${JSON.stringify(DEFAULT_LOCALE)})===${JSON.stringify(DEFAULT_LOCALE)})d.setAttribute("${FRESH_ATTR}","");`;

/** Same rule as FRESH_DEMO_PREPAINT, read now (storage can change after the first paint). */
export function isFreshDemoVisit(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const l = window.localStorage;
    const q = new URLSearchParams(window.location.search);
    const known = LOCALES as readonly (string | null)[];
    const lang = q.get("lang"), saved = l.getItem(LOCALE_STORAGE_KEY);
    const locale = known.includes(lang) ? lang : known.includes(saved) ? saved : DEFAULT_LOCALE;
    return !l.getItem(MOCK_STORE_KEY) && !l.getItem(ACTIVE_WALLET_KEY) && !q.has("demo") && locale === DEFAULT_LOCALE;
  } catch {
    return false;
  }
}

/** Who a first demo visit acts as: the first persona, Thabo (the wallet picks the same when nothing is saved). */
export function firstDemoPersona(): WalletSession {
  return personaSessions()[0];
}

/** Ends the first-visit view: from now on the page shows its own state (called once the real screen is up). */
export function endFreshVisit(): void {
  if (typeof document !== "undefined") document.documentElement.removeAttribute(FRESH_ATTR);
}
