/** Plan §18.3 S4: estate names are saved only over the copy they were built on, in memory and in Supabase. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EstateMeta } from "./db";

const h = vi.hoisted(() => ({
  configured: false,
  calls: [] as [string, ...unknown[]][],
  result: { data: [] as unknown, error: null as { message: string } | null },
}));

vi.mock("./supabase", () => ({
  getSupabase: () => {
    if (!h.configured) return null;
    const query: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => resolve(h.result),
    };
    for (const method of ["update", "upsert", "select", "eq", "gte", "lt", "maybeSingle"]) {
      query[method] = (...args: unknown[]) => { h.calls.push([method, ...args]); return query; };
    }
    return { from: () => query };
  },
}));

let db: typeof import("./db");
const meta = (updatedAt: number, ownerName = "Thabo"): EstateMeta => ({
  estate: "E", ownerWallet: "O", ownerName, verifierNames: ["a", "b", "c"], assetTitles: {}, buyerNames: {}, updatedAt,
});

beforeEach(async () => {
  vi.resetModules();
  Object.assign(h, { configured: false, calls: [], result: { data: [{ estate: "E" }], error: null } });
  db = await import("./db");
});

describe("in memory", () => {
  it("is not durable, and says so", () => expect(db.metaIsDurable()).toBe(false));

  it("inserts only when nothing is there", async () => {
    expect(await db.saveEstateMeta(meta(1), null)).toBe(true);
    expect(await db.saveEstateMeta(meta(2, "Second"), null)).toBe(false);
    expect((await db.getEstateMeta("E"))?.ownerName).toBe("Thabo");
  });

  it("replaces only the copy it was built on", async () => {
    await db.saveEstateMeta(meta(1), null);
    expect(await db.saveEstateMeta(meta(2, "Second"), meta(1))).toBe(true);
    expect(await db.saveEstateMeta(meta(3, "Built on the first"), meta(1))).toBe(false);
    expect((await db.getEstateMeta("E"))?.ownerName).toBe("Second");
  });
});

describe("in Supabase", () => {
  beforeEach(() => { h.configured = true; });

  it("is durable", () => expect(db.metaIsDurable()).toBe(true));

  it("an insert never overwrites", async () => {
    await db.saveEstateMeta(meta(5), null);
    expect(h.calls[0][0]).toBe("upsert");
    expect(h.calls[0][2]).toEqual({ onConflict: "estate", ignoreDuplicates: true });
  });

  it("an update is conditional on the stored time", async () => {
    await db.saveEstateMeta(meta(2_000), meta(1_000));
    expect(h.calls.map((c) => c[0])).toEqual(["update", "eq", "gte", "lt", "select"]);
    expect(h.calls[2][2]).toBe(new Date(1_000).toISOString());
    expect(h.calls[3][2]).toBe(new Date(1_001).toISOString());
  });

  it("says when nothing matched", async () => {
    h.result = { data: [], error: null };
    expect(await db.saveEstateMeta(meta(2), meta(1))).toBe(false);
  });

  it("a failed write throws", async () => {
    h.result = { data: null, error: { message: "down" } };
    await expect(db.saveEstateMeta(meta(2), null)).rejects.toThrow("down");
  });

  it("a failed read throws when asked strictly, and is empty otherwise", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.result = { data: null, error: { message: "down" } };
    await expect(db.getEstateMeta("E", { strict: true })).rejects.toThrow("down");
    expect(await db.getEstateMeta("E")).toBeNull();
  });

  it("reads the stored time back", async () => {
    h.result = {
      error: null,
      data: { estate: "E", owner_wallet: "O", owner_name: "T", verifier_names: ["a", "b", "c"], updated_at: "2026-11-22T10:00:00.123456+00:00" },
    };
    expect((await db.getEstateMeta("E"))?.updatedAt).toBe(Date.UTC(2026, 10, 22, 10, 0, 0, 123));
  });
});
