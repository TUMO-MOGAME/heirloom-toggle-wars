/**
 * A room of judges on one Wi-Fi (one IP address), in lamports. The arithmetic behind the sponsor's limits:
 *
 *   budget                                                300,000,000  a day (0.3 SOL)
 *   shared rent allowance   70% = 210,000,000 / 2,039,280   = 102 accounts      208,006,560
 *   shared fee allowance    30% =  90,000,000 /    20,000   = 4,500 signatures   90,000,000
 *   their worst case                                                             298,006,560
 *
 *   30 judges, 100 transactions each, 3 of them with rent (90 accounts):
 *     usual fee  3,000 x 10,000 + 90 x 2,039,280                                 213,535,200
 *     top fee    3,000 x 20,000 + 90 x 2,039,280                                 243,535,200
 *
 *   backstop, hour   300,000,000 + 50,000,000 of the agent's own                 350,000,000
 *   backstop, day    300,000,000 + 100,000,000 of the agent's own                400,000,000
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ takes: [] as { key: string; max: number; windowSecs: number }[][] }));
vi.mock("server-only", () => ({}));
vi.mock("../server/shared-store", () => ({
  takeShared: async (takes: (typeof h.takes)[number]) => { h.takes.push(takes); return null; },
}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => true }));
vi.mock("./server", () => ({
  sponsorInfo: async () => ({ available: true, balanceLamports: 1 }),
  sponsorTransaction: async () => ({ signature: "sig" }),
  SimulationFailed: class extends Error {},
  SponsorLimited: class extends Error {},
  SponsorUnavailable: class extends Error {},
}));

const { DEFAULT_SPONSOR_LIMITS: limits, SponsorLimiter, sharedTakes } = await import("./limits");
const { DEFAULT_LIMITS, TOKEN_ACCOUNT_RENT } = await import("./policy");
const { AGENT_SPEND } = await import("../agent/budget");
const route = await import("@/app/api/sponsor/route");

const JUDGES = 30;
const USUAL_FEE = 10_000;
const DAY_START = 1_800_000_000_000;

describe("a room of judges on one Wi-Fi", () => {
  beforeEach(() => { h.takes = []; });

  const ask = (method: "GET" | "POST", ip: string) => route[method](new Request("http://t/api/sponsor", {
    method,
    headers: { "x-forwarded-for": ip, "x-real-ip": ip },
    ...(method === "POST" ? { body: JSON.stringify({ tx: "A".repeat(120) }) } : {}),
  }));

  it.each([["POST", "198.51.100.7"], ["GET", "198.51.100.8"]] as const)("%s: one address has 90 a minute", async (method, ip) => {
    for (let i = 0; i < 90; i++) expect((await ask(method, ip)).status).toBe(200);
    expect((await ask(method, ip)).status).toBe(429);
    expect((await ask(method, "203.0.113.9")).status).toBe(200);
  });

  it("the shared store holds the address to the same 90 a minute", async () => {
    await ask("POST", "198.51.100.10");
    expect(h.takes.flat()).toEqual([expect.objectContaining({ max: 90, windowSecs: 60 })]);
  });

  it("one wallet has 20 a minute", () => {
    const limiter = new SponsorLimiter();
    for (let i = 0; i < 20; i++) {
      expect(limiter.check("W", USUAL_FEE, false, DAY_START + i)).toBeNull();
      limiter.record("W", USUAL_FEE, false, DAY_START + i);
    }
    expect(limiter.check("W", USUAL_FEE, false, DAY_START + 20)).toMatch(/wait a minute/);
    expect(limiter.check("W", USUAL_FEE, false, DAY_START + 60_020)).toBeNull();
  });

  it.each([[USUAL_FEE, 213_535_200], [DEFAULT_LIMITS.maxFeeLamports, 243_535_200]])(
    "30 judges use all of their 100 a day at a fee of %i: %i in all, none refused",
    (fee, total) => {
      const limiter = new SponsorLimiter();
      let spent = 0;
      let now = DAY_START;
      for (let i = 0; i < limits.perDay; i++) {
        now = DAY_START + i * 60_000;
        for (let judge = 0; judge < JUDGES; judge++) {
          const rent = i < limits.rentPerDay;
          const cost = fee + (rent ? TOKEN_ACCOUNT_RENT : 0);
          expect(limiter.check(`J${judge}`, cost, rent, now)).toBeNull();
          limiter.record(`J${judge}`, cost, rent, now);
          spent += cost;
        }
      }
      expect(limiter.check("J0", fee, false, now + 60_000)).toMatch(/today's limit/);
      expect(spent).toBe(total);
      expect(spent).toBeLessThanOrEqual(limits.dailyBudgetLamports);
    },
  );

  it("the shared takes fit the room and stay inside 0.3 SOL", () => {
    const takes = Object.fromEntries(sharedTakes("W", true, limits, DEFAULT_LIMITS.maxFeeLamports).map((t) => [t.key, t.max]));
    expect(takes).toEqual({
      "sponsor:minute:W": 20, "sponsor:day:W": 100, "sponsor:fees": 4_500, "sponsor:rent:W": 3, "sponsor:rent": 102,
    });
    expect(takes["sponsor:fees"]).toBeGreaterThanOrEqual(JUDGES * limits.perDay);
    expect(takes["sponsor:rent"]).toBeGreaterThanOrEqual(JUDGES * limits.rentPerDay);

    const worst = takes["sponsor:fees"] * DEFAULT_LIMITS.maxFeeLamports + takes["sponsor:rent"] * TOKEN_ACCOUNT_RENT;
    expect(worst).toBe(298_006_560);
    expect(limits.dailyBudgetLamports).toBe(300_000_000);
    expect(worst).toBeLessThanOrEqual(limits.dailyBudgetLamports);
  });

  it("without the shared store the backstop leaves room for the whole budget in one hour", () => {
    expect(AGENT_SPEND.hour).toBe(limits.dailyBudgetLamports + 50_000_000);
    expect(AGENT_SPEND.day).toBe(limits.dailyBudgetLamports + 100_000_000);
  });
});
