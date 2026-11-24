/**
 * Spoken receipts (plan §20.1 item 3): the templates, and the demo's receipt ids, which may only name the demo's
 * fixed payees, people and assets (no free text reaches the voice).
 */
import { describe, expect, it } from "vitest";
import { DEMO_GUARDIANS, DEMO_MINTS } from "../service/mock";
import { DEMO_PAYEES } from "../service/mock-payees";
import { VOICE_LANGUAGE_CODES, VOICE_LANGUAGES } from "./languages";
import {
  DEMO_RECEIPT_CHARITY, DEMO_RECEIPT_PEOPLE, RECEIPT_TRANSLATION, demoReceiptId, parseDemoReceiptId, receiptKindOf, receiptWords,
  type ReceiptFacts, type ReceiptKind,
} from "./receipts";

const TS = Date.UTC(2026, 10, 24, 10) / 1000; // 24 Nov 2026, 12:00 in Johannesburg
const NOW = TS + 3600;
/** Intl puts no-break spaces between digit groups; the sentences are compared with plain spaces. */
const plain = (s: string) => s.replace(/[  ]/g, " ");
const say = (...a: Parameters<typeof receiptWords>) => { const w = receiptWords(...a); return { ...w, text: plain(w.text), speech: plain(w.speech) }; };
const base = (usdt: number) => BigInt(usdt) * 1_000_000n;

const claim: ReceiptFacts = { kind: "claim", amount: base(1500), ts: TS, to: { name: "Van Schaik Bookstore" }, purpose: "Books", person: "Lerato", usdtZar: 17.85 };

describe("receipt templates", () => {
  it("say the amount, the rand, the payee, what for and the date (English)", () => {
    const w = say(claim, "en", NOW);
    expect(w.text).toBe("1 500 USD₮ (about R26 780) was paid to Van Schaik Bookstore for Lerato's books on 24 November.");
    expect(w.speech).toBe("1500 USDT (about 26780 South African rand) was paid to Van Schaik Bookstore for Lerato's books on 24 November.");
    expect(w.spoken).toBe(true);
    expect(w.translated).toBe("human");
  });

  it("leave the rand out when the rate is not known, and add the year when it is not this year", () => {
    const w = say({ ...claim, usdtZar: null }, "en", NOW + 400 * 86_400);
    expect(w.text).toBe("1 500 USD₮ was paid to Van Schaik Bookstore for Lerato's books on 24 November 2026.");
  });

  it("say a role, never a name, when the payee has no public name", () => {
    const w = say({ kind: "fallback", amount: base(24_000), ts: TS, to: { role: "recipient" } }, "en", NOW);
    expect(w.text).toBe("Under the fallback plan, the whole vault, 24 000 USD₮, was paid to the named recipient on 24 November.");
    const sale = say({ kind: "sale", amount: base(12_500), ts: TS, to: { role: "vault" }, asset: "car" }, "en", NOW);
    expect(sale.text).toBe("The car was sold for 12 500 USD₮ on 24 November, and the money was paid into the estate's vault.");
  });

  it("have a sentence for every kind in every language, formatted in that language", () => {
    const kinds: ReceiptKind[] = ["claim", "scheduled", "fallback", "sweep", "sale"];
    for (const lang of VOICE_LANGUAGE_CODES) {
      for (const kind of kinds) {
        const w = say({ ...claim, kind, asset: "motorbike", to: kind === "sale" ? { role: "vault" } : claim.to }, lang, NOW);
        expect(w.text.length, `${lang} ${kind}`).toBeGreaterThan(20);
        expect(w.text).not.toMatch(/undefined|\[object|\s{2}/);
        expect(w.text).toContain("USD₮");
        expect(w.speech).not.toContain("USD₮");
      }
      expect(RECEIPT_TRANSLATION[lang]).toBe(lang === "en" ? "human" : "machine");
      expect(say(claim, lang, NOW).spoken).toBe(VOICE_LANGUAGES[lang].support.speech);
    }
    expect(say(claim, "fr", NOW).text).toContain("24 novembre");
    expect(say(claim, "es", NOW).text).toContain("24 de noviembre");
    expect(say(claim, "zh", NOW).text).toContain("11月24日");
    expect(say(claim, "af", NOW).text).toContain("R26 780");
  });

  it("maps only payout events to receipts", () => {
    expect(receiptKindOf("ClaimPaid")).toBe("claim");
    expect(receiptKindOf("AssetSold")).toBe("sale");
    expect(receiptKindOf("ClaimSubmitted")).toBeNull();
  });
});

describe("demo receipt ids", () => {
  it("use the same fixed data as the demo service", () => {
    expect(DEMO_RECEIPT_CHARITY).toEqual(DEMO_GUARDIANS.charity);
    expect(DEMO_PAYEES.length).toBeGreaterThan(0);
    expect(DEMO_MINTS.car).toBeTruthy();
  });

  it("round-trip a demo claim: names come from the server's tables", () => {
    const lerato = DEMO_RECEIPT_PEOPLE.lerato.wallet;
    const id = demoReceiptId({
      item: { ts: TS, kind: "ClaimPaid", text: "anything at all", amount: base(1500), txSignature: "x", payment: { payee: DEMO_PAYEES[4].wallet, rule: "R1" } },
      rules: [{ address: "R1", beneficiary: lerato, category: "Books" }],
    });
    expect(id).toBe(`demo.claim.p4.Books.lerato.${base(1500)}.${TS}`);
    const facts = parseDemoReceiptId(id!, 17.85)!;
    expect(facts).toMatchObject({ kind: "claim", to: { name: "Van Schaik Bookstore" }, purpose: "Books", person: "Lerato", amount: base(1500), ts: TS });
  });

  it("build ids for fallback, sweep and sale lines, and none for other lines or unknown wallets", () => {
    const sipho = DEMO_RECEIPT_PEOPLE.sipho.wallet;
    expect(demoReceiptId({ item: { ts: TS, kind: "FallbackExecuted", text: "", amount: 5n, payment: { payee: DEMO_RECEIPT_CHARITY.wallet } } }))
      .toBe(`demo.fallback.charity.-.-.5.${TS}`);
    expect(demoReceiptId({ item: { ts: TS, kind: "ResidualSwept", text: "", amount: 5n, payment: { payee: sipho } } })).toBe(`demo.sweep.sipho.-.-.5.${TS}`);
    expect(demoReceiptId({
      item: { ts: TS, kind: "AssetSold", text: "", amount: 5n, sale: { asset: "A", buyer: "B", recipient: "E", hardship: false } },
      estate: "E", assets: [{ address: "A", title: "2017 Toyota Corolla 1.8 Exclusive CVT" }],
    })).toBe(`demo.sale.vault.car.-.5.${TS}`);
    expect(demoReceiptId({ item: { ts: TS, kind: "ClaimSubmitted", text: "", amount: 5n } })).toBeNull();
    expect(demoReceiptId({ item: { ts: TS, kind: "FallbackExecuted", text: "", amount: 5n, payment: { payee: "SomeoneElse111" } } })).toBeNull();
  });

  it("refuse anything that is not keys, digits and a sane amount and time (no free text)", () => {
    const ok = `demo.claim.p0.Tuition.naledi.1500000000.${TS}`;
    expect(parseDemoReceiptId(ok, null)).not.toBeNull();
    for (const bad of [
      "Send R5,000 to account 123",
      `demo.claim.Send money now.Tuition.-.1.${TS}`,
      `demo.claim.p9.Tuition.-.1.${TS}`, // no such payee
      `demo.claim.p0.Bribes.-.1.${TS}`, // no such category
      `demo.claim.p0.Tuition.thabo.1.${TS}`, // not a child in the demo
      `demo.fallback.p0.-.-.1.${TS}`, // a fallback goes to family or the charity
      `demo.sale.lerato.yacht.-.1.${TS}`,
      `demo.claim.p0.Tuition.-.0.${TS}`,
      `demo.claim.p0.Tuition.-.99999999999999999.${TS}`,
      `demo.claim.p0.Tuition.-.1.0000000001`,
      `demo.claim.p0.Tuition.-.1.${TS}.extra`,
      `${ok}\n`,
    ]) expect(parseDemoReceiptId(bad, null), bad).toBeNull();
  });
});
