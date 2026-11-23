/**
 * Plan §18.9 (low): anonymous model and voice spend had no ceiling. Each paid route now takes from a day's cap in all,
 * with one address held to a share of it; past it, 429 daily_limit until the day turns. Through the real routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ valued: 0, sessions: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/shared-store", () => ({ takeShared: async () => null, claimSharedOnce: async () => null }));
vi.mock("@/lib/agent/valuation", () => ({ valueCar: async () => { h.valued++; return { suggestedAskingUsdt: 1 }; } }));

const { DAILY_CAPS, dailyCap } = await import("./http");
const valuation = await import("@/app/api/valuation/route");

const car = { make: "Toyota", model: "Corolla", year: 2017, mileageKm: 100_000, condition: "good" };
let ip = 0;
const value = (from = `10.20.${Math.floor(++ip / 250)}.${ip % 250}`) =>
  valuation.POST(new Request("http://t/api/valuation", { method: "POST", headers: { "x-forwarded-for": from }, body: JSON.stringify(car) }));

beforeEach(() => { h.valued = 0; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 10, 23, 9) + ip * 1000); });

describe("a day's cap on anonymous AI use", () => {
  it("one address is held to its share, and the next address is still served", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < DAILY_CAPS.search.perIp + 1; i++) {
      vi.setSystemTime(Date.now() + 61_000); // past the per-minute limit, inside the day
      statuses.push((await value("198.51.100.77")).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(DAILY_CAPS.search.perIp);
    expect(statuses.at(-1)).toBe(429);
    expect((await value("198.51.100.78")).status).toBe(200);
    vi.useRealTimers();
  });

  it("everyone together stops at the day's total, and starts again the next day", async () => {
    const req = (n: number) => new Request("http://t", { headers: { "x-forwarded-for": `172.16.${n >> 8}.${n & 255}` } });
    const at = Date.UTC(2026, 10, 24, 10);
    for (let i = 0; i < DAILY_CAPS.voice.all; i++) await dailyCap(req(i), "voice", at);
    await expect(dailyCap(req(99_999), "voice", at)).rejects.toMatchObject({ status: 429, code: "daily_limit" });
    await expect(dailyCap(req(1), "voice", at + 86_400_000)).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("is generous enough for a room of thirty judges on one Wi-Fi", () => {
    expect(DAILY_CAPS.model.perIp).toBeGreaterThanOrEqual(30 * 20);
    expect(DAILY_CAPS.voice.perIp).toBeGreaterThanOrEqual(30);
  });
});
