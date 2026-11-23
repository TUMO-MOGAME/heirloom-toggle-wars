import { afterEach, describe, expect, it } from "vitest";
import { FRESH_ATTR, FRESH_DEMO_PREPAINT, isFreshDemoVisit } from "./fresh-visit";
import { MOCK_STORE_KEY } from "./is-mock";
import { ACTIVE_WALLET_KEY } from "../wallet/store";
import { LOCALE_STORAGE_KEY } from "../i18n/locales";

/** A visit: what this browser has saved and the page's query string. */
type Visit = { saved?: Record<string, string>; search?: string };

const storage = (saved: Record<string, string> = {}) => ({ getItem: (k: string) => (k in saved ? saved[k] : null) });

/** Runs the inline pre-paint script the way the root layout does and says whether it marked <html>. */
function prepaint({ saved, search = "" }: Visit): boolean {
  const attrs = new Set<string>();
  const d = { setAttribute: (name: string) => attrs.add(name) };
  new Function("l", "d", "location", FRESH_DEMO_PREPAINT)(storage(saved), d, { search });
  return attrs.has(FRESH_ATTR);
}

function inBrowser({ saved, search = "" }: Visit): boolean {
  (globalThis as { window?: unknown }).window = { localStorage: storage(saved), location: { search } };
  return isFreshDemoVisit();
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

const cases: [string, Visit, boolean][] = [
  ["nothing saved", {}, true],
  ["a saved demo estate", { saved: { [MOCK_STORE_KEY]: "{}" } }, false],
  ["a chosen persona", { saved: { [ACTIVE_WALLET_KEY]: "6ckEzZLHJ4XLXLP7jrkjFau22cK8KhV2cVeWyhqJmSWm" } }, false],
  ["a ?demo= link", { search: "?demo=funded" }, false],
  ["isiZulu saved", { saved: { [LOCALE_STORAGE_KEY]: "zu" } }, false],
  ["English saved", { saved: { [LOCALE_STORAGE_KEY]: "en" } }, true],
  ["?lang=af", { search: "?lang=af" }, false],
  ["?lang=en over a saved isiZulu", { search: "?lang=en", saved: { [LOCALE_STORAGE_KEY]: "zu" } }, true],
  ["an unknown ?lang= falls back to the saved language", { search: "?lang=xx", saved: { [LOCALE_STORAGE_KEY]: "st" } }, false],
  ["an unknown saved language means English", { saved: { [LOCALE_STORAGE_KEY]: "xx" } }, true],
];

describe("first demo visit", () => {
  it.each(cases)("%s", (_name, visit, fresh) => {
    expect(prepaint(visit)).toBe(fresh);
    expect(inBrowser(visit)).toBe(fresh);
  });

  it("is never fresh outside a browser", () => {
    expect(isFreshDemoVisit()).toBe(false);
  });

  it("treats blocked storage as not fresh", () => {
    (globalThis as { window?: unknown }).window = { localStorage: { getItem: () => { throw new Error("blocked"); } }, location: { search: "" } };
    expect(isFreshDemoVisit()).toBe(false);
  });
});
