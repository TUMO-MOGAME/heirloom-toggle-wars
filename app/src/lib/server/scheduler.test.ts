/**
 * Plan §18.3 S1. The whole tick runs over real encoded accounts, a fake RPC and a fake agent wallet: ten failing
 * schedules from four estates used to take every place, every tick, forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Rule } from "../types";

const h = vi.hoisted(() => ({
  agent: "",
  mint: "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5",
  accounts: new Map<string, { owner: unknown; data: Buffer; lamports: number; executable: boolean }>(),
  /** Rules whose transaction fails at the last moment, for a reason the accounts don't show. */
  failing: new Set<string>(),
  /** Rules whose transaction never answers. */
  hanging: new Set<string>(),
  sent: [] as string[],
  reads: [] as number[],
  clock: 0,
  sendMs: 0,
  readFails: 0,
  ruleSlot: 0,
  ixs: [] as { keys: { pubkey: { toBase58(): string } }[] }[],
}));

// The version gate (plan §18.9 C1) has its own tests: lib/chain/release.test.ts.
vi.mock("@/lib/server/program", () => ({ assertProgram: async () => undefined, programProblem: async () => null }));
vi.mock("../chain/config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, usdtMint: h.mint } };
});
vi.mock("../chain/client", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const { getIdl } = await import("../chain/idl");
  return { chainCtx: () => ({ programId: new PublicKey(getIdl().address), usdtMint: new PublicKey(h.mint) }) };
});
vi.mock("../agent/agent-wallet", () => ({
  agentAddress: async () => h.agent,
  agentSignAndSend: async ([ix]: TransactionInstruction[]) => {
    h.ixs.push(ix);
    const rule = ix.keys[h.ruleSlot].pubkey.toBase58();
    h.sent.push(rule);
    h.clock += h.sendMs;
    if (h.hanging.has(rule)) return new Promise(() => undefined);
    if (h.failing.has(rule)) throw new Error("Simulation failed at https://rpc.example/?api-key=secret");
    return { signature: `sig-${rule}`, explorerUrl: "url" };
  },
}));
vi.mock("../chain/tx", () => ({
  getConnection: () => ({
    getProgramAccounts: async (program: PublicKey, o: { filters: { memcmp: { offset: number; bytes: string } }[] }) => {
      const wants = o.filters.map(({ memcmp }) => ({ at: memcmp.offset, bytes: Buffer.from(bs58.decode(memcmp.bytes)) }));
      return [...h.accounts]
        .filter(([, a]) => (a.owner as PublicKey).equals(program) && wants.every((w) => a.data.subarray(w.at, w.at + w.bytes.length).equals(w.bytes)))
        .map(([address, account]) => ({ pubkey: new PublicKey(address), account }));
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (keys.length > 100) throw new Error("getMultipleAccounts takes 100 at most");
      h.reads.push(keys.length);
      if (h.readFails > 0) { h.readFails--; throw new Error("429"); }
      return keys.map((k) => h.accounts.get(k.toBase58()) ?? null);
    },
  }),
}));

const { getCoder, getIdl } = await import("../chain/idl");
const { TOKEN_PROGRAM_ID, ata, beneficiaryPda, payeePda, yearCapPda } = await import("../chain/pda");
const { TICK, isDue, runDueSchedules, servedPayments } = await import("./scheduler");
const { fairOrder, scheduleOrder } = await import("./schedule-order");
const { AGENT_RENT, forgetAgentRent } = await import("../agent/budget");

h.ruleSlot = getIdl().instructions.find((i) => i.name === "execute_scheduled")!.accounts.findIndex((a) => a.name === "rule");
const programId = new PublicKey(getIdl().address);
const mint = new PublicKey(h.mint);
const key = () => Keypair.generate().publicKey;
const bn = (v: bigint | number) => new BN(String(v));
const NOW = 1_800_000_000;
const ONE = 1_000_000n;

function seeded(start: number) {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const put = (address: PublicKey, owner: PublicKey, data: Buffer) =>
  h.accounts.set(address.toBase58(), { owner, data, lamports: 1, executable: false });

async function program(address: PublicKey, type: string, value: Record<string, unknown>) {
  put(address, programId, await getCoder().accounts.encode(type, value));
}

function token(owner: PublicKey, amount: bigint, over: { holder?: PublicKey; state?: number } = {}) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  (over.holder ?? owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = over.state ?? 1;
  put(ata(mint, owner), TOKEN_PROGRAM_ID, data);
}

async function addEstate(o: { vault?: bigint; status?: string; agent?: string; mint?: PublicKey } = {}) {
  const address = key();
  await program(address, "Estate", {
    owner: key(), agent: new PublicKey(o.agent ?? h.agent), usdt_mint: o.mint ?? mint, verifiers: [key(), key(), key()],
    death_threshold: 2, claim_threshold: 1, hardship_threshold: 2, waiting_period_secs: bn(120),
    status: { [o.status ?? "Active"]: {} }, will_hash: Array(32).fill(0), will_uri: "", death_cert_hash: Array(32).fill(0),
    death_submitted_by: PublicKey.default, death_verdict: { Pending: {} }, death_attestations: 0,
    death_pending_since: bn(0), last_heartbeat: bn(0), rule_count: 1, bump: 255,
  });
  token(address, o.vault ?? 1_000n * ONE);
  return address;
}

async function addRule(estate: PublicKey, o: {
  due?: number; amount?: bigint; spent?: bigint; cap?: bigint; until?: number; startsNow?: boolean;
  payee?: "removed" | "other-kind"; beneficiary?: "inactive" | "removed"; fails?: boolean; yearly?: { cap: bigint; spent: bigint; start: number };
} = {}) {
  const address = key(), payee = key(), beneficiary = key();
  await program(address, "Rule", {
    estate, id: 0, beneficiary, category: { Accommodation: {} }, allowed_payee_kind: { Landlord: {} },
    max_per_claim: bn(o.amount ?? 5n * ONE), lifetime_cap: bn(o.cap ?? 10_000n * ONE), spent_total: bn(o.spent ?? 0n),
    valid_until: bn(o.until ?? NOW + 86_400), claim_count: 0, starts_now: o.startsNow ?? true,
    recurring_amount: bn(o.amount ?? 5n * ONE), interval_secs: bn(60), next_due: bn(o.due ?? NOW - 10), fixed_payee: payee, bump: 255,
  });
  if (o.payee !== "removed") {
    await program(payeePda(programId, estate, payee), "Payee", { estate, wallet: payee, kind: o.payee === "other-kind" ? { School: {} } : { Landlord: {} }, name: "Approved landlord", bump: 255 });
  }
  if (o.beneficiary !== "removed") {
    await program(beneficiaryPda(programId, estate, beneficiary), "Beneficiary", {
      estate, wallet: beneficiary, label: "Family member 1", active: o.beneficiary !== "inactive", bump: 255,
    });
  }
  if (o.yearly) {
    await program(yearCapPda(programId, address), "YearCap", {
      rule: address, cap: bn(o.yearly.cap), period_start: bn(o.yearly.start), period_spent: bn(o.yearly.spent), bump: 255,
    });
  }
  if (o.fails) h.failing.add(address.toBase58());
  return { address: address.toBase58(), payee, beneficiary };
}

const tick = (seed = 1) => runDueSchedules(NOW, { random: seeded(seed), clock: () => h.clock });
const paidIn = (results: { rule: string; ok: boolean }[]) => results.filter((r) => r.ok).map((r) => r.rule);

beforeEach(() => {
  forgetAgentRent();
  h.agent = key().toBase58();
  h.accounts.clear(); h.failing.clear(); h.hanging.clear();
  h.sent = []; h.ixs = []; h.reads = []; h.clock = 0; h.sendMs = 0; h.readFails = 0;
});

const rule = (over: Partial<Rule> = {}): Rule => ({
  address: "R", id: 0, beneficiary: "B", category: "Accommodation", allowedPayeeKind: "Landlord",
  maxPerClaim: 300n, lifetimeCap: 1000n, spentTotal: 0n, validUntil: 2_000, startsNow: true,
  recurringAmount: 300n, intervalSecs: 60, nextDue: 1_000, fixedPayee: "P", ...over,
});

describe("scheduler isDue (mirrors execute_scheduled)", () => {
  it("pays a due living-plan rule while the owner is alive", () => expect(isDue(rule(), "Active", 1_000)).toBe(true));
  it("waits until next_due", () => expect(isDue(rule(), "Active", 999)).toBe(false));
  it("after-death rules need an unlocked estate", () => {
    expect(isDue(rule({ startsNow: false }), "Active", 1_500)).toBe(false);
    expect(isDue(rule({ startsNow: false }), "Unlocked", 1_500)).toBe(true);
  });
  it("respects the lifetime cap and end date", () => {
    expect(isDue(rule({ spentTotal: 800n }), "Active", 1_500)).toBe(false);
    expect(isDue(rule(), "Active", 2_001)).toBe(false);
  });
  it("ignores non-recurring rules and frozen estates", () => {
    expect(isDue(rule({ recurringAmount: 0n }), "Active", 1_500)).toBe(false);
    expect(isDue(rule(), "Frozen", 1_500)).toBe(false);
    expect(isDue(rule(), "DeathPending", 1_500)).toBe(false);
  });
});

describe("failing schedules can't starve the others (S1)", { timeout: 60_000 }, () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("four estates with sixteen failing rules each, and the good rule is paid (seed %i)", async (seed) => {
    for (let e = 0; e < 4; e++) {
      const estate = await addEstate();
      for (let r = 0; r < 16; r++) await addRule(estate, { due: 1_000 + r, fails: true });
    }
    const good = await addRule(await addEstate());
    const results = await tick(seed);
    expect(paidIn(results)).toEqual([good.address]);
    expect(results.filter((r) => !r.ok).length).toBeGreaterThan(0);
  });

  it("failures use no success slot: thirty failing estates and ten good ones, all ten paid in one tick", async () => {
    for (let e = 0; e < 30; e++) await addRule(await addEstate(), { due: 1_000, fails: true });
    const good: string[] = [];
    for (let e = 0; e < TICK.paid; e++) good.push((await addRule(await addEstate())).address);
    expect(paidIn(await tick()).sort()).toEqual(good.sort());
  });

  it("what can't pay costs no attempt: 120 empty estates ahead of one good rule, paid in the first tick", async () => {
    for (let e = 0; e < 120; e++) await addRule(await addEstate({ vault: ONE }), { due: 1_000 });
    const good = await addRule(await addEstate());
    expect(paidIn(await tick())).toEqual([good.address]);
    expect(h.sent).toEqual([good.address]);
    expect(Math.max(...h.reads)).toBeLessThanOrEqual(100); // batched
  });

  it("more failing estates than a tick has attempts: the good rule is still paid within a few ticks", async () => {
    for (let e = 0; e < 120; e++) await addRule(await addEstate(), { due: 1_000 + e, fails: true });
    const good = await addRule(await addEstate()); // the newest due: last of all, by age
    let ticks = 0, paid = false;
    while (!paid && ticks < 25) paid = paidIn(await tick(++ticks)).includes(good.address);
    expect(paid).toBe(true);
  });

  it("a failing rule with the oldest date can't block its own estate", async () => {
    const estate = await addEstate();
    for (let r = 0; r < 15; r++) await addRule(estate, { due: 1_000 + r, fails: true });
    const good = await addRule(estate);
    let ticks = 0, paid = false;
    while (!paid && ticks < 25) paid = paidIn(await tick(++ticks)).includes(good.address);
    expect(paid).toBe(true);
  });

  it("pays a few per estate, and a few per tick", async () => {
    const busy = await addEstate();
    for (let r = 0; r < 8; r++) await addRule(busy);
    expect(paidIn(await tick())).toHaveLength(TICK.paidPerEstate);
    for (let e = 0; e < 14; e++) await addRule(await addEstate());
    expect(paidIn(await tick())).toHaveLength(TICK.paid);
  });

  it("tries a few per estate, and a bounded number per tick", async () => {
    const one = await addEstate();
    for (let r = 0; r < 10; r++) await addRule(one, { fails: true });
    expect(await tick()).toHaveLength(TICK.attemptsPerEstate);
    for (let e = 0; e < 70; e++) await addRule(await addEstate(), { fails: true });
    expect(await tick()).toHaveLength(TICK.attempts);
  });

  it("starts nothing once its time is up", async () => {
    for (let e = 0; e < 30; e++) await addRule(await addEstate(), { fails: true });
    h.sendMs = 9_000;
    await tick();
    expect(h.sent).toHaveLength(Math.ceil(TICK.startUntilMs / 9_000));
    expect(h.clock).toBeLessThan(60_000);
  });

  it("gives up on a payment that never answers, and pays the next", async () => {
    const stuck = await addRule(await addEstate(), { due: 1_000 });
    const good = await addRule(await addEstate());
    h.hanging.add(stuck.address);
    vi.useFakeTimers();
    try {
      const run = tick();
      await vi.advanceTimersByTimeAsync(TICK.attemptMs + 10);
      const results = await run;
      expect(paidIn(results)).toEqual([good.address]);
      expect(results.find((r) => r.rule === stuck.address)?.error).toMatch(/no answer in time/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed read (429) doesn't end the tick", async () => {
    for (let e = 0; e < TICK.window + 1; e++) await addRule(await addEstate());
    h.readFails = 1;
    expect(paidIn(await tick())).toHaveLength(1);
  });

  it("never reports an RPC URL", async () => {
    await addRule(await addEstate(), { fails: true });
    expect((await tick())[0].error).toBe("Simulation failed at [url]");
  });
});

describe("what can't pay is passed over without a transaction (S1)", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["a vault short of the instalment", async () => addRule(await addEstate({ vault: 4n * ONE }))],
    ["no vault", async () => { const e = await addEstate(); h.accounts.delete(ata(mint, e).toBase58()); await addRule(e); }],
    ["a frozen vault", async () => { const e = await addEstate(); token(e, 1_000n * ONE, { state: 2 }); await addRule(e); }],
    ["the lifetime cap", async () => addRule(await addEstate(), { spent: 96n * ONE, cap: 100n * ONE })],
    ["the yearly cap", async () => addRule(await addEstate(), { yearly: { cap: 20n * ONE, spent: 16n * ONE, start: NOW - 100 } })],
    ["the end date", async () => addRule(await addEstate(), { until: NOW - 1 })],
    ["a date still to come", async () => addRule(await addEstate(), { due: NOW + 1 })],
    ["an amount too small to be worth the fee", async () => addRule(await addEstate(), { amount: ONE - 1n })],
    ["a payee that was removed", async () => addRule(await addEstate(), { payee: "removed" })],
    ["a payee put back as another kind", async () => addRule(await addEstate(), { payee: "other-kind" })],
    ["a beneficiary that was removed", async () => addRule(await addEstate(), { beneficiary: "inactive" })],
    ["a beneficiary account that is gone", async () => addRule(await addEstate(), { beneficiary: "removed" })],
    ["a payee account handed to someone else", async () => { token((await addRule(await addEstate())).payee, 0n, { holder: key() }); }],
    ["a frozen payee account", async () => { token((await addRule(await addEstate())).payee, 0n, { state: 2 }); }],
    ["a death claim under way", async () => addRule(await addEstate({ status: "DeathPending" }))],
    ["an after-death rule while the owner lives", async () => addRule(await addEstate(), { startsNow: false })],
    ["another agent's estate", async () => addRule(await addEstate({ agent: key().toBase58() }))],
    ["another mint's estate", async () => addRule(await addEstate({ mint: key() }))],
  ];

  it.each(cases)("%s", async (_why, arrange) => {
    await arrange();
    expect(await tick()).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("but a yearly cap in a new period pays, and so does a payee who has a token account already", async () => {
    const renewed = await addRule(await addEstate(), { yearly: { cap: 20n * ONE, spent: 20n * ONE, start: NOW - 366 * 86_400 } });
    const held = await addRule(await addEstate());
    token(held.payee, 3n * ONE);
    expect(paidIn(await tick()).sort()).toEqual([renewed.address, held.address].sort());
  });

  it("two rules share one vault: only what it holds is sent", async () => {
    const estate = await addEstate({ vault: 8n * ONE });
    await addRule(estate);
    await addRule(estate);
    expect(await tick()).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it("its one call passes the Beneficiary and Payee accounts every payout re-checks (R16)", async () => {
    const estate = await addEstate();
    const r = await addRule(estate);
    expect(await tick()).toHaveLength(1);
    expect(h.ixs[0].keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual([
      beneficiaryPda(programId, estate, r.beneficiary).toBase58(), payeePda(programId, estate, r.payee).toBase58(),
    ]);
  });

  it("servedPayments keeps only this agent's estates", () => {
    const due = (estate: string) => ({ estate, rule: { recurringAmount: ONE } });
    const estates = new Map([["a", { agent: "A", usdtMint: "M" }], ["b", { agent: "other", usdtMint: "M" }]]);
    expect(servedPayments([due("a"), due("b"), due("c")], estates, "A", "M")).toEqual([due("a")]);
  });
});

describe("rent for payees' accounts is bounded and counted (M7)", () => {
  it("a payee who closes their account after each payment gets its rent back a few times a day, never more", async () => {
    const estate = await addEstate({ vault: 10_000n * ONE });
    let paid = 0;
    for (let day = 0; day < 1; day++) {
      for (let i = 0; i < 6; i++) {
        await addRule(estate); // a payee with no USD₮ account each time
        paid += paidIn(await tick(i + 1)).length;
      }
    }
    expect(paid).toBe(AGENT_RENT.schedulePerEstate);
  });

  it("across estates the day's rent stops at its cap, and payees who have an account are still paid", async () => {
    for (let e = 0; e < AGENT_RENT.scheduleDay + 5; e++) await addRule(await addEstate());
    const held = await addRule(await addEstate());
    token(held.payee, 0n);
    let paid: string[] = [];
    for (let t = 0; t < 8; t++) paid = [...paid, ...paidIn(await tick(t + 1))];
    expect(paid).toContain(held.address);
    expect(paid.filter((r) => r !== held.address)).toHaveLength(AGENT_RENT.scheduleDay);
  });
});

describe("the order", () => {
  it("takes the oldest and a rotation in turn, each once", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ i }));
    const order = fairOrder(items, (x) => x.i, seeded(3));
    expect(new Set(order).size).toBe(9);
    expect(order.slice(0, 2)).toContainEqual({ i: 0 });
  });

  it("gives every estate a turn before any gets a second", () => {
    const due = ["a", "a", "a", "a", "b", "c"].map((estate, i) => ({ estate, rule: { nextDue: i } }));
    const order = scheduleOrder(due, seeded(4));
    expect(order).toHaveLength(6);
    expect(new Set(order.slice(0, 3).map((d) => d.estate))).toEqual(new Set(["a", "b", "c"]));
  });

  it("copes with a very large backlog", () => {
    const due = Array.from({ length: 50_000 }, (_, i) => ({ estate: `e${i % 25_000}`, rule: { nextDue: i } }));
    expect(scheduleOrder(due, seeded(5))).toHaveLength(50_000);
  });
});
