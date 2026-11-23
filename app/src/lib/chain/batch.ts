/**
 * Coalesces account reads: every getAccountInfo made within a few milliseconds becomes one getMultipleAccounts call.
 * One page load used to make 20+ separate reads, which the public devnet RPC answers with HTTP 429.
 */
export const BATCH_MAX = 100; // getMultipleAccounts' limit
const WINDOW_MS = 15;

export function batched<K, V>(loadMany: (keys: K[]) => Promise<V[]>, max = BATCH_MAX, windowMs = WINDOW_MS): (key: K) => Promise<V> {
  let queue: { key: K; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];
  const flush = () => {
    const all = queue;
    queue = [];
    for (let i = 0; i < all.length; i += max) {
      const part = all.slice(i, i + max);
      loadMany(part.map((x) => x.key)).then(
        (values) => part.forEach((x, j) => x.resolve(values[j])),
        (e: unknown) => part.forEach((x) => x.reject(e)),
      );
    }
  };
  return (key) => new Promise<V>((resolve, reject) => {
    queue.push({ key, resolve, reject });
    if (queue.length === 1) setTimeout(flush, windowMs);
  });
}
