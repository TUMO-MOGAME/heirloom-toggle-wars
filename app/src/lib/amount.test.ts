/** H1: one strict amount reading. "9,50" is nine rand fifty, never 950. */
import { describe, expect, it } from "vitest";
import { amountHint, amountsInText, amountText, parseAmount } from "./amount";

describe("parseAmount", () => {
  it.each([
    ["9,50", 9.5], ["9.50", 9.5], ["1 234,50", 1234.5], ["1\u00a0234,50", 1234.5], ["1,234.50", 1234.5], ["1,000", 1000],
    ["12.345,60", 12345.6], ["1.000.000", 1_000_000], ["1,000,000.25", 1_000_000.25], ["0,005", 0.005], ["0.123456", 0.123456],
    ["300", 300], ["1 250", 1250], ["1234.567", 1234.567], ["0,500", 0.5], ["19.44", 19.44],
  ])("%s → %s", (text, n) => expect(parseAmount(text)).toBe(n));

  it.each(["1.000", "1.234", "12,34,567", "1,2345.6", "1,234,56", "1.234,567,8", "0.1234567", "-5", "5,", ",5", "1 23", "12 345 6", "abc", "", "1e3", "1 000.000,5"])(
    "refuses %j", (text) => expect(parseAmount(text)).toBeNull());

  it("writes amounts it can read back", () => {
    for (const n of [12.345, 9.5, 1000, 0.000001, 1234.5678, 7]) expect(parseAmount(amountText(n))).toBe(n);
  });
});

describe("amountsInText", () => {
  const first = (t: string) => amountsInText(t)[0];
  it("reads the currency written beside the number", () => {
    expect(first("send R9,50 to Lerato")).toMatchObject({ value: 9.5, unit: "zar" });
    expect(first("pay $49,50 to Sipho")).toMatchObject({ value: 49.5, unit: "usd" });
    expect(first("give Sipho 12.50 USD₮.")).toMatchObject({ value: 12.5, unit: "usd" });
    expect(first("send R2k to Sipho")).toMatchObject({ value: 2000, unit: "zar" });
    expect(first("send 1 500 rand")).toMatchObject({ value: 1500, unit: "zar" });
  });
  it("marks an amount that could mean two things", () => {
    expect(first("send 1.000 USDT to Sipho")).toMatchObject({ value: null, unit: "usd" });
  });
});

describe("the hint under an amount field (N9)", () => {
  const words = { unclear: "UNCLEAR", format: "FORMAT" };
  const ok = (n: number) => (n > 0 ? `= ${n}` : undefined);
  it("how to write it while empty; the unclear words, never a conversion, for an amount read two ways", () => {
    expect(amountHint("", ok, words)).toBe("FORMAT");
    expect(amountHint("  ", ok, words)).toBe("FORMAT");
    expect(amountHint("1.000", ok, words)).toBe("UNCLEAR");
    expect(amountHint("12,34,567", ok, words)).toBe("UNCLEAR");
    expect(amountHint("1,000", ok, words)).toBe("= 1000");
    expect(amountHint("9,50", ok, words)).toBe("= 9.5");
    expect(amountHint("0", ok, words)).toBe("FORMAT");
  });
});
