/**
 * The order the scheduler tries due payments in (plan §18.3 S1). It keeps no state between ticks, so fairness comes
 * from two lanes taken in turn:
 *  - oldest due first, so an honest backlog is paid in order;
 *  - a random rotation, so payments that fail forever (they keep the oldest due date, and an estate can pick any
 *    first date it likes) can't hold every place: whatever stands behind them gets its turn within a few ticks,
 *    whatever the tick's cadence.
 * And every estate's first payment comes before any estate's second, so one estate can't take a tick by itself.
 */
export type Random = () => number;

export function shuffled<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The two lanes in turn, each item once. A coin decides which lane starts. */
export function fairOrder<T>(items: readonly T[], dueAt: (item: T) => number, random: Random): T[] {
  const oldest = [...items].sort((a, b) => dueAt(a) - dueAt(b));
  const rotation = shuffled(items, random);
  const lanes = random() < 0.5 ? [oldest, rotation] : [rotation, oldest];
  const out = new Set<T>();
  for (let i = 0; i < items.length; i++) for (const lane of lanes) out.add(lane[i]);
  return [...out];
}

/** Fair across estates, and within each estate. */
export function scheduleOrder<T extends { estate: string; rule: { nextDue: number | null } }>(due: readonly T[], random: Random): T[] {
  const byEstate = new Map<string, T[]>();
  for (const d of due) {
    const list = byEstate.get(d.estate);
    if (list) list.push(d);
    else byEstate.set(d.estate, [d]);
  }
  const estates = fairOrder(
    [...byEstate.values()].map((list) => ({
      oldest: list.reduce((min, d) => Math.min(min, d.rule.nextDue ?? Infinity), Infinity),
      list: fairOrder(list, (d) => d.rule.nextDue ?? Infinity, random),
    })),
    (e) => e.oldest,
    random,
  );
  const out: T[] = [];
  for (let round = 0; out.length < due.length; round++) {
    for (const e of estates) if (round < e.list.length) out.push(e.list[round]);
  }
  return out;
}
