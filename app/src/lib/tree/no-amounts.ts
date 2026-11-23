/**
 * The tree never carries an amount (plan.md §15.2). `findAmounts` walks any value and lists every place that looks
 * like one: a bigint, or a key named like an amount, value, price, balance or USD₮ figure. Used by the tests on both
 * the mock story and the chain tree.
 */
const AMOUNT_KEY = /amount|value|price|balance|usdt|floor|cap$|spent|asking|zar|fee/i;

export function findAmounts(value: unknown, path = "$"): string[] {
  if (typeof value === "bigint") return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => findAmounts(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(AMOUNT_KEY.test(k) ? [`${path}.${k}`] : []),
      ...findAmounts(v, `${path}.${k}`),
    ]);
  }
  return [];
}
