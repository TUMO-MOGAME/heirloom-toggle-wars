export const USDT_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDT_DECIMALS);

/** Whole/decimal USD₮ (number) → base units (bigint). */
export function toBase(usdt: number): bigint {
  return BigInt(Math.round(usdt * Number(UNIT)));
}

/** Base units → number of USD₮ (display only). */
export function fromBase(base: bigint): number {
  return Number(base) / Number(UNIT);
}

// Number.toLocaleString builds a new Intl.NumberFormat on every call, which is slow on phones and these run on
// every render; one formatter per option set gives the same output.
const formatters = new Map<string, Intl.NumberFormat>();
function numberFormat(min: number | undefined, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-ZA", min === undefined ? { maximumFractionDigits: max } : { minimumFractionDigits: min, maximumFractionDigits: max });
    formatters.set(key, f);
  }
  return f;
}

export function formatUsdt(base: bigint, opts: { decimals?: number } = {}): string {
  const d = opts.decimals ?? 2;
  return `${numberFormat(d, d).format(fromBase(base))} USD₮`;
}

/** Every decimal there is, at least two when there are any: what is signed is what is read ("9,50 USD₮", "13 500 USD₮"). */
export function formatUsdtExact(base: bigint): string {
  const whole = base % UNIT === 0n;
  return `${numberFormat(whole ? 0 : 2, USDT_DECIMALS).format(fromBase(base))} USD₮`;
}

export function formatZar(base: bigint, usdtZar: number): string {
  return `R ${numberFormat(undefined, 0).format(fromBase(base) * usdtZar)}`;
}

export function shortAddress(a: string, n = 4): string {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function explorerTx(signature: string, cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet"): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function explorerAddress(address: string, cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet"): string {
  return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
}
