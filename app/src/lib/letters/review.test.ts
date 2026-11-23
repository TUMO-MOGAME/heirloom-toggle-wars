/** "Check my letter": one test per warning code, each with a near miss (plan.md §16.12). */
import { describe, expect, it } from "vitest";
import { isSaId, mergeReview, needsSeedList, reviewDraft, reviewRules, type ReviewCtx } from "./review";
import { BIP39_ENGLISH } from "./bip39-english";
import { letters } from "@/content/letters";

const ESTATE = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const LERATO = "FXb3FikjwrPU8nR8WjJB6y4LCZ1esdw3vkUybPwMvGZZ";
const SIPHO = "BMiTCRtWEettDpHQvL9kBt5bkSpiNeAMZYwYUmaAybbV";
const COROLLA = { address: "CaR1111111111111111111111111111111", title: "2017 Toyota Corolla 1.8 Exclusive CVT", proceedsTo: ESTATE };
const BIKE = { address: "BiKe111111111111111111111111111111", title: "2025 Big Boy Mustang 250", proceedsTo: SIPHO, kind: "Motorbike" };
const ctx = (over: Partial<ReviewCtx> = {}): ReviewCtx => ({ estate: ESTATE, recipient: LERATO, recipientName: "Lerato", assets: [COROLLA, BIKE], usdtZar: 18, ...over });
const codes = (text: string, c: Partial<ReviewCtx> = {}) => reviewRules(text, ctx(c), BIP39_ENGLISH).map((w) => w.code);

describe("secrets", () => {
  it("secret.pin: a PIN or OTP with digits; 'pin the photo' is not a PIN", () => {
    expect(codes("Lerato, my PIN is 1234, use it for the house alarm.")).toContain("secret.pin");
    expect(codes("The OTP will be 482113.")).toContain("secret.pin");
    expect(codes("Pin the photo of Gogo on the fridge, 1999 was a good year.")).not.toContain("secret.pin");
  });
  it("secret.password: a password with a value; mentioning one is fine", () => {
    expect(codes("The email password is Sunshine2026")).toContain("secret.password");
    expect(codes("My wagwoord is: blou-huis")).toContain("secret.password");
    expect(codes("I always forgot my password, you know that.")).not.toContain("secret.password");
  });
  it("secret.seed: recovery phrase words, or 12 BIP-39 words in a row; ordinary prose is fine", () => {
    expect(codes("Here is the seed phrase for the wallet")).toContain("secret.seed");
    const twelve = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(needsSeedList(twelve)).toBe(true);
    expect(codes(`Keep this safe: ${twelve}`)).toContain("secret.seed");
    expect(codes("you were the best thing that ever happened to me and your mother and the rest of us")).not.toContain("secret.seed");
  });
  it("secret.card: 15-19 digits passing Luhn; a failing number is not a card", () => {
    expect(codes("Card 4111 1111 1111 1111 is in the drawer")).toContain("secret.card");
    expect(codes("Order 4111 1111 1111 1112 arrived")).not.toContain("secret.card");
  });
  it("secret.account: an account word near 6-11 digits; a year is not an account", () => {
    expect(codes("The savings account number is 62812345678.")).toContain("secret.account");
    expect(codes("Die rekening: 1234567")).toContain("secret.account");
    expect(codes("We opened the account in 2009.")).not.toContain("secret.account");
  });
  it("secret.idNumber: a valid SA ID (date + Luhn); a 13-digit invoice number that is not one", () => {
    expect(isSaId("8001015009087")).toBe(true);
    expect(codes("My ID is 800101 5009 087.")).toContain("secret.idNumber");
    expect(codes("Invoice 8001015009080 was paid.")).toEqual([]);
    expect(codes("Invoice 9913991234563 was paid.")).toEqual([]);
  });
});

describe("the will", () => {
  it("will.asset: 'the Corolla is yours' while the plan sells it into the vault", () => {
    const w = reviewRules("Lerato, the Corolla is yours, look after it.", ctx(), BIP39_ENGLISH);
    expect(w.map((x) => x.code)).toEqual(["will.asset"]);
    expect(w[0].vars).toEqual({ asset: "Corolla", name: "Lerato" });
    expect(w[0].quote).toContain("Corolla is yours");
  });
  it("agreeing text gives no warning (the demo's L2 letter)", () => {
    const l2 = letters.demo.lerato.text;
    expect(codes(l2, { about: COROLLA.address })).toEqual([]);
  });
  it("an 'about' asset counts as named ('it is yours')", () => {
    expect(codes("It is yours now.", { about: COROLLA.address })).toEqual(["will.asset"]);
    expect(codes("It is yours now.")).toEqual([]);
  });
  it("will.other: the plan gives the asset to someone else; to its heir it is fine", () => {
    expect(codes("Lerato, the motorbike is yours.")).toEqual(["will.other"]);
    expect(codes("Sipho, the Mustang is yours.", { recipient: SIPHO, recipientName: "Sipho" })).toEqual([]);
    expect(codes("Ke ya hao, koloi ena.")).toEqual(["will.asset"]);
  });
  it("will.amount: a gift letter naming an amount more than 5% off the rule's payment", () => {
    expect(codes("The 500 USD₮ is yours to start something.", { giftUsdt: 500 })).toEqual([]);
    expect(codes("Here is R 9 000 for you.", { giftUsdt: 500 })).toEqual([]);
    expect(codes("Here is 800 USDT for your birthday.", { giftUsdt: 500 })).toEqual(["will.amount"]);
    expect(codes("Here is 800 USDT for your birthday.")).toEqual([]);
  });
});

describe("merging the AI's warnings", () => {
  it("never drops a rule warning, adds new codes once, ignores unknown codes", () => {
    const rules = reviewRules("my PIN is 1234", ctx());
    const merged = mergeReview(rules, [{ code: "secret.pin", quote: "x" }, { code: "will.other", note: "It promises the house." }, { code: "made.up" }]);
    expect(merged.map((w) => w.code)).toEqual(["secret.pin", "will.other"]);
    expect(merged[0]).toEqual(rules[0]);
  });
  it("reviewDraft loads the word list only when needed", async () => {
    expect((await reviewDraft("abandon ability able about above absent absorb abstract absurd abuse access accident", ctx())).map((w) => w.code)).toEqual(["secret.seed"]);
    expect(await reviewDraft("Love, Dad", ctx())).toEqual([]);
  });
});
