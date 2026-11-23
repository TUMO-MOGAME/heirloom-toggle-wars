/** Plan §18.3 S2: every refusal says when to try again, or where else to get test SOL, in four languages. */
import { describe, expect, it } from "vitest";
import { continuity } from "@/content/continuity";
import { LOCALES } from "../i18n/locales";
import { FAUCET_URL, retryTime, starterRefusalText } from "./refusal";

const NOW = Date.UTC(2026, 10, 27, 9, 0, 20);
const WITH_TIME = ["hourly_cap", "daily_cap", "rate_limited", "busy"];
const OTHERS = ["already_funded", "empty", "unavailable", "proof", "replay", "server", undefined];

describe("starter refusals", () => {
  it.each([...LOCALES])("%s: the timed ones give the time", (locale) => {
    const t = continuity[locale].starter;
    for (const code of WITH_TIME) {
      const r = starterRefusalText(t, { code, retryAfterSecs: 600 }, NOW);
      expect(r.text).toContain(retryTime(NOW, 600));
      expect(r.text).not.toContain("{");
      expect(r.faucet).toBe(true);
    }
  });

  it.each([...LOCALES])("%s: the others point to the faucet", (locale) => {
    const t = continuity[locale].starter;
    for (const code of OTHERS) {
      const r = starterRefusalText(t, { code }, NOW);
      expect(r.text.length).toBeGreaterThan(5);
      expect(r.text).not.toContain("{");
      expect(r.faucet).toBe(true);
    }
    expect(t.faucet.length).toBeGreaterThan(5);
  });

  it("every language has its own words, and a place for each time", () => {
    const en = continuity.en.starter;
    for (const locale of LOCALES) {
      const t = continuity[locale].starter;
      for (const key of ["hourlyCap", "dailyCap", "rateLimited", "busy"] as const) expect(t.refused[key]).toContain("{time}");
      if (locale !== "en") for (const [key, text] of Object.entries(t.refused)) expect(text).not.toBe(en.refused[key as keyof typeof en.refused]);
    }
  });

  it("gives a time even when the server sent none", () => {
    expect(starterRefusalText(continuity.en.starter, { code: "hourly_cap" }, NOW).text).toContain(retryTime(NOW, 3_600));
  });

  it("rounds up to the minute, never early", () => {
    expect(retryTime(NOW, 1)).toBe(retryTime(NOW, 40));
    expect(retryTime(NOW, 1)).not.toBe(retryTime(NOW, 41));
  });

  it("adds the weekday when it is not today", () => {
    expect(retryTime(NOW, 86_400).length).toBeGreaterThan(retryTime(NOW, 60).length);
  });

  it("links the official faucet", () => expect(FAUCET_URL).toBe("https://faucet.solana.com"));
});
