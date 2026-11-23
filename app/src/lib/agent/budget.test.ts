/** Plan §18.3 S3: the agent's allowances, shared when they can be, and backed by the chain when they can't. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  taken: null as null | { ok: true } | { ok: false; retryAfterSecs: number },
  takes: [] as { key: string; max: number; windowSecs: number }[][],
  spend: { hour: 0, day: 0, complete: true } as { hour: number; day: number; complete: boolean; read?: boolean } | Error,
  /** The agent's own share; by default all of it. */
  own: null as { hour: number; day: number } | null,
  reads: 0,
}));

vi.mock("../server/shared-store", () => ({
  takeShared: async (t: { key: string; max: number; windowSecs: number }[]) => { h.takes.push(t); return h.taken; },
}));
vi.mock("../server/agent-ledger", () => ({
  agentLedger: () => ({
    spend: async () => {
      h.reads++;
      if (h.spend instanceof Error) throw h.spend;
      return { read: true, ...h.spend, own: h.own ?? { hour: h.spend.hour, day: h.spend.day } };
    },
  }),
}));
vi.mock("../chain/tx", () => ({ getConnection: () => ({}) }));
vi.mock("./agent-wallet", () => ({ agentAddress: async () => "261pQudaK5J4v1WCtcGjWidWU9ww3KyYC4TiU8jDsjNg" }));

let budget: typeof import("./budget");
const T0 = 1_800_000_000_000;
const spend = (i: number, now = T0, estate = `E${i}`) => budget.spendAgentAllowance("review", `W${i}`, estate, now);

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  Object.assign(h, { taken: null, takes: [], spend: { hour: 0, day: 0, complete: true }, own: null, reads: 0 });
  budget = await import("./budget");
});

describe("allowances", () => {
  it("per wallet, with a time to retry", async () => {
    const max = budget.AGENT_DAILY["list-asset"].wallet;
    for (let i = 0; i < max; i++) await budget.spendAgentAllowance("list-asset", "W", `E${i}`, T0 + i);
    await expect(budget.spendAgentAllowance("list-asset", "W", "another", T0 + 10_000))
      .rejects.toMatchObject({ status: 429, code: "agent_limit", retryAfterSecs: 86_390 });
  });

  it("per estate", async () => {
    const max = budget.AGENT_DAILY["list-asset"].estate;
    for (let i = 0; i < max; i++) await budget.spendAgentAllowance("list-asset", `W${i}`, "E", T0);
    await expect(budget.spendAgentAllowance("list-asset", "one more", "E", T0)).rejects.toMatchObject({ status: 429 });
  });

  it("requests arriving together can't all pass", async () => {
    const max = budget.AGENT_DAILY["accept-offer"].wallet;
    const all = await Promise.allSettled(Array.from({ length: max + 5 }, () => budget.spendAgentAllowance("accept-offer", "W", "E", T0)));
    expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(max);
  });

  it("the shared store decides when it is there, and the chain is not asked", async () => {
    h.taken = { ok: true };
    await spend(1);
    expect(h.takes[0].map((t) => [t.max, t.windowSecs])).toEqual([[20, 86_400], [40, 86_400]]);
    h.taken = { ok: false, retryAfterSecs: 99 };
    await expect(spend(2)).rejects.toMatchObject({ status: 429, retryAfterSecs: 99 });
    expect(h.reads).toBe(0);
  });

  it("a refusal doesn't use up the allowance", async () => {
    h.taken = { ok: false, retryAfterSecs: 5 };
    for (let i = 0; i < 25; i++) await expect(budget.spendAgentAllowance("review", "W", "E", T0)).rejects.toThrow();
    h.taken = { ok: true };
    await expect(budget.spendAgentAllowance("review", "W", "E", T0)).resolves.toBeUndefined();
  });
});

describe("rent the agent pays (M7)", () => {
  it("sales: a cap for all estates together, on this instance and in the shared store", async () => {
    for (let i = 0; i < budget.AGENT_RENT.settleDay; i++) await budget.spendAgentRent("settle", `E${i}`, T0 + i);
    await expect(budget.spendAgentRent("settle", "another", T0 + 99)).rejects.toMatchObject({ status: 429, code: "agent_limit" });
    expect(h.takes.at(-1)).toEqual([{ key: "agent:rent:settle", max: budget.AGENT_RENT.settleDay, windowSecs: 86_400 }]);
  });

  it("another instance using it up counts here too", async () => {
    h.taken = { ok: false, retryAfterSecs: 500 };
    await expect(budget.spendAgentRent("schedule", "E", T0)).rejects.toMatchObject({ retryAfterSecs: 500 });
    expect(budget.agentRentLeft("schedule", "E", T0 + 1)).toBe(false);
  });
});

describe("the chain backstop, without a shared store", () => {
  it("stops at the hour's spend", async () => {
    h.spend = { hour: budget.AGENT_SPEND.hour, day: budget.AGENT_SPEND.hour, complete: true };
    h.own = { hour: budget.AGENT_OWN_SPEND.hour, day: budget.AGENT_OWN_SPEND.hour };
    await expect(spend(1)).rejects.toMatchObject({ status: 429, retryAfterSecs: 3_600 });
    await expect(budget.chainBackstop(T0)).rejects.toMatchObject({ status: 429, retryAfterSecs: 3_600 });
  });

  it("the sponsor's whole day spent in one judging hour doesn't stop the agent", async () => {
    const budgetLamports = 300_000_000;
    h.spend = { hour: budgetLamports, day: budgetLamports, complete: true };
    h.own = { hour: 0, day: 0 };
    await expect(spend(1)).resolves.toBeUndefined();
  });

  it("no amount of sponsored fees switches off reviews, listings or sales (H3)", async () => {
    h.spend = { hour: 50 * budget.AGENT_SPEND.hour, day: 50 * budget.AGENT_SPEND.day, complete: true };
    h.own = { hour: 1_000_000, day: 2_000_000 };
    for (const action of ["review", "list-asset", "accept-offer"] as const) {
      await expect(budget.spendAgentAllowance(action, "W", "E", T0)).resolves.toBeUndefined();
    }
    // The sponsor itself is stopped by the same reading.
    await expect(budget.chainBackstop(T0)).rejects.toMatchObject({ status: 429, code: "agent_limit" });
  });

  it("nor does a sponsored backlog still being read, nor the sponsor using up its blind allowance", async () => {
    h.spend = { hour: 0, day: 0, complete: true, read: false };
    for (let i = 0; i < budget.AGENT_SPEND.blind; i++) await budget.chainBackstop(T0 + i);
    await expect(budget.chainBackstop(T0 + 20)).rejects.toMatchObject({ status: 503 });
    for (let i = 0; i < 2 * budget.AGENT_SPEND.blind; i++) await spend(i, T0 + i);
  });


  it("stops at the day's spend", async () => {
    h.spend = { hour: 0, day: budget.AGENT_SPEND.day, complete: true };
    await expect(spend(1)).rejects.toMatchObject({ status: 429, code: "agent_limit" });
  });

  it("lets normal use through, reading the chain at most every twenty seconds", async () => {
    for (let i = 0; i < 30; i++) await spend(i, T0 + i);
    expect(h.reads).toBe(1);
    await spend(31, T0 + budget.AGENT_SPEND.freshMs + 1);
    expect(h.reads).toBe(2);
  });

  it("a 429 after a good reading: that reading stands", async () => {
    await spend(0);
    h.spend = new Error("429");
    for (let i = 1; i < 25; i++) await spend(i, T0 + 60_000 + i);
  });

  it("a 429 after a reading over the limit: still stopped", async () => {
    h.spend = { hour: budget.AGENT_SPEND.hour, day: 0, complete: true };
    await expect(spend(0)).rejects.toMatchObject({ status: 429 });
    h.spend = new Error("429");
    await expect(spend(1, T0 + 60_000)).rejects.toMatchObject({ status: 429 });
  });

  it("no reading at all: a handful still work, then it says wait", async () => {
    h.spend = new Error("429");
    for (let i = 0; i < budget.AGENT_SPEND.blind; i++) await spend(i);
    await expect(spend(99)).rejects.toMatchObject({ status: 503, code: "busy", retryAfterSecs: 60 });
    await spend(100, T0 + budget.AGENT_SPEND.staleMs + 1);
  });

  it("a flooded history (a lower bound) counts as no reading", async () => {
    h.spend = { hour: 0, day: 0, complete: false };
    for (let i = 0; i < budget.AGENT_SPEND.blind; i++) await spend(i);
    await expect(spend(99)).rejects.toMatchObject({ status: 503 });
  });
});
