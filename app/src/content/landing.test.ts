import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { landing, receiptTxs } from "./landing";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";

const headings = (l: typeof landing | typeof af.landing) => ({
  hero: l.hero.title, problem: l.problem.title, purposes: l.purposes.title, how: l.how.title,
  safety: l.safety.title, proof: l.proof.title, cta: l.cta.title,
});

describe("landing copy", () => {
  it("quotes the problem facts exactly as docs/landing-facts.md says them", () => {
    const facts = readFileSync(path.resolve(__dirname, "../../../docs/landing-facts.md"), "utf8");
    for (const f of landing.problem.facts) expect(facts, f.say).toContain(`**${f.say}**`);
  });

  it("has one real devnet transaction per receipt row", () => {
    expect(receiptTxs).toHaveLength(landing.proof.receipts.rows.length);
    for (const sig of receiptTxs) expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
  });

  it.each([["en", landing], ["af", af.landing], ["st", st.landing], ["zu", zu.landing]] as const)(
    "%s: every heading has exactly one *marked* phrase",
    (_lang, l) => {
      for (const [key, title] of Object.entries(headings(l))) expect(title.split("*").length, key).toBe(3);
    },
  );

  it.each([["af", af.landing], ["st", st.landing], ["zu", zu.landing]] as const)("%s: translates every landing key", (_lang, tr) => {
    const missing: string[] = [];
    const walk = (en: unknown, t: unknown, at: string) => {
      // Slots that are empty in English (a fact with no second sentence, a receipt with no amount) stay empty.
      if (typeof en === "string") { if (en && (typeof t !== "string" || !t.trim())) missing.push(at); return; }
      if (Array.isArray(en)) {
        if (!Array.isArray(t) || t.length !== en.length) missing.push(at);
        else en.forEach((x, i) => walk(x, t[i], `${at}[${i}]`));
        return;
      }
      if (en && typeof en === "object") for (const k of Object.keys(en)) walk((en as Record<string, unknown>)[k], (t as Record<string, unknown> | undefined)?.[k], `${at}.${k}`);
    };
    walk(landing, tr, "landing");
    expect(missing).toEqual([]);
    // Sources keep their links; amounts and brand names stay as they are.
    expect(tr.problem.sources.map((s) => s.href)).toEqual(landing.problem.sources.map((s) => s.href));
    expect(tr.proof.receipts.rows.map((r) => r.amount)).toEqual(landing.proof.receipts.rows.map((r) => r.amount));
    for (const item of tr.strip.items.slice(0, 3)) expect(item.term).toMatch(/Tether|Solana/);
  });
});
