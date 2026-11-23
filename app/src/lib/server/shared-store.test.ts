/**
 * Plan §18.3 S3: replay protection and limits across instances. Two "instances" are two copies of each module over
 * one fake Supabase that behaves as supabase/migrations/0009_server_limits.sql does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  mode: "up" as "up" | "off" | "broken" | "hang",
  once: new Set<string>(),
  hits: new Map<string, number>(),
  keys: [] as string[],
  calls: [] as string[],
}));

vi.mock("../supabase", () => ({
  getSupabase: () => h.mode === "off" ? null : {
    rpc: (fn: string, a: { p_key?: string; p_keys?: string[]; p_maxes?: number[]; p_windows?: number[] }) => {
      h.calls.push(fn);
      if (h.mode === "broken") return Promise.resolve({ data: null, error: { message: "function does not exist" } });
      if (h.mode === "hang") return new Promise(() => undefined);
      if (fn === "heirloom_use_once") {
        h.keys.push(a.p_key!);
        const fresh = !h.once.has(a.p_key!);
        h.once.add(a.p_key!);
        return Promise.resolve({ data: fresh, error: null });
      }
      h.keys.push(...a.p_keys!);
      if (a.p_keys!.some((k, i) => (h.hits.get(k) ?? 0) >= a.p_maxes![i])) return Promise.resolve({ data: 120, error: null });
      for (const k of a.p_keys!) h.hits.set(k, (h.hits.get(k) ?? 0) + 1);
      return Promise.resolve({ data: 0, error: null });
    },
  },
}));

async function instance() {
  vi.resetModules();
  const nonces = await import("../access/nonces");
  const http = await import("../api/http");
  const store = await import("./shared-store");
  return { firstUse: nonces.createNonces("action", 600_000), http, store };
}

const request = (ip = "203.0.113.9") => new Request("http://t/api/starter", { headers: { "x-forwarded-for": ip } });

beforeEach(() => {
  Object.assign(h, { mode: "up", keys: [], calls: [] });
  h.once.clear();
  h.hits.clear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("single use", () => {
  it("a request replayed on another instance is refused when the store is there", async () => {
    const [a, b] = [await instance(), await instance()];
    expect(await a.firstUse("sig")).toBe(true);
    expect(await b.firstUse("sig")).toBe(false);
  });

  it("two copies arriving together: one passes", async () => {
    h.mode = "off";
    const a = await instance();
    expect((await Promise.all([a.firstUse("sig"), a.firstUse("sig")])).sort()).toEqual([false, true]);
  });

  it.each(["off", "broken"] as const)("with the store %s it still works once per instance", async (mode) => {
    h.mode = mode;
    const a = await instance();
    expect(await a.firstUse("sig")).toBe(true);
    expect(await a.firstUse("sig")).toBe(false);
  });

  it("is forgotten on this instance after its time", async () => {
    h.mode = "off";
    const a = await instance();
    expect(await a.firstUse("sig", 1_000)).toBe(true);
    expect(await a.firstUse("sig", 1_000 + 600_001)).toBe(true);
  });
});

describe("rateLimitShared", () => {
  it("one allowance for both instances, and says when to retry", async () => {
    const [a, b] = [await instance(), await instance()];
    await a.http.rateLimitShared(request(), "starter", 2);
    await b.http.rateLimitShared(request(), "starter", 2);
    const refused = await a.http.rateLimitShared(request(), "starter", 2).catch(a.http.errorResponse) as Response;
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("120");
    expect(await refused.json()).toMatchObject({ code: "rate_limited", retryAfter: 120 });
    await b.http.rateLimitShared(request("198.51.100.7"), "starter", 2);
  });

  it("without a store it is the limit of this instance", async () => {
    h.mode = "off";
    const a = await instance();
    await a.http.rateLimitShared(request(), "starter", 1);
    await expect(a.http.rateLimitShared(request(), "starter", 1)).rejects.toMatchObject({ status: 429 });
  });
});

describe("the store", () => {
  it("never sees an IP address, wallet or signature", async () => {
    const a = await instance();
    await a.firstUse("a-signature");
    await a.http.rateLimitShared(request(), "review", 5);
    expect(h.keys).toHaveLength(2);
    for (const k of h.keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers null, never throws, when it isn't there or doesn't answer", async () => {
    const a = await instance();
    h.mode = "off";
    expect(await a.store.takeShared([{ key: "k", max: 1, windowSecs: 60 }])).toBeNull();
    h.mode = "hang";
    vi.useFakeTimers();
    try {
      const waiting = a.store.claimSharedOnce("k", 60);
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await waiting).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("supabase/migrations/0009_server_limits.sql", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "../supabase/migrations/0009_server_limits.sql"), "utf8").replace(/--.*$/gm, "");

  it("RLS on both tables, no policy, nothing for the public roles", () => {
    for (const table of ["server_once", "server_hits"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated;`);
    }
    expect(sql).not.toMatch(/create policy|security definer|to (anon|authenticated|public);/i);
  });

  it("only the service role may run the functions", () => {
    for (const fn of ["heirloom_use_once(text, integer)", "heirloom_take(text[], integer[], integer[])"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${fn} to service_role;`);
    }
    expect(sql).toContain("pg_advisory_xact_lock");
  });
});
