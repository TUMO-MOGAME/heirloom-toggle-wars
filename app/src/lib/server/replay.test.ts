/**
 * Plan §18.3 S3, chain wave: every signed route's single use, the costly routes' limits and the voice's allowance
 * hold across instances. The shared store is a fake; signatures are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import bs58 from "bs58";

const h = vi.hoisted(() => ({
  /** What another instance already used: the store answers false for a repeat. */
  used: new Set<string>(),
  claimed: [] as string[],
  takes: [] as { key: string; max: number; windowSecs: number }[],
  taken: null as null | { ok: true } | { ok: false; retryAfterSecs: number },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/shared-store", () => ({
  claimSharedOnce: async (key: string) => {
    h.claimed.push(key);
    if (h.used.has(key)) return false;
    h.used.add(key);
    return true;
  },
  takeShared: async (takes: typeof h.takes) => { h.takes.push(...takes); return h.taken; },
}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => true }));
vi.mock("@/lib/server/estate", () => ({ loadSnapshot: async () => { throw new Error("no chain here"); } }));

const { askRoutes } = await import("../ask/server/route");
const { askMessage } = await import("../ask/auth-message");
const { treeRoutes } = await import("../tree/server/route");
const { photoRoutes } = await import("../tree/server/photo-route");
const { treeBody, treeMessage } = await import("../tree/links");
const { lettersRoutes } = await import("../letters/server/route");
const { LIST_BODY, letterMessage } = await import("../letters/canonical");
const { authorize } = await import("../legacy/server/auth");
const { countSpeak } = await import("../legacy/server/service");
const { AUTH_HEADER, authMessage, encodeAuth } = await import("../legacy/auth-message");
const { authorizeOwner } = await import("../media/server/auth");
const { mediaAuthMessage } = await import("../media/api");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const wallet = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const sign = (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex");
const estate = bs58.encode(Buffer.alloc(32, 7));
const claim = bs58.encode(Buffer.alloc(32, 8));
const deps = { chain: () => true, now: () => Date.now(), fetchRaw: async () => null };
const post = (body: object) => new Request("http://t/api", { method: "POST", body: JSON.stringify(body) });
const signed = (ts: number, message: string) => ({ estate, wallet, ts, sig: sign(message) });

/** One signed request for each route that had its own per-instance store: the code it answers and the signature. */
const requests: Record<string, () => { sig: string; run(): Promise<string | undefined> }> = {
  ask: () => {
    const ts = Date.now();
    const b = { action: "decline", claim, ...signed(ts, askMessage("decline", estate, claim, wallet, ts, sha(""))) };
    return { sig: b.sig, run: async () => ((await (await askRoutes(deps).POST(post(b))).json()) as { code?: string }).code };
  },
  tree: () => {
    const ts = Date.now();
    const b = { action: "hide", hidden: true, ...signed(ts, treeMessage("hide", estate, wallet, ts, sha(treeBody({ action: "hide", hidden: true })))) };
    return { sig: b.sig, run: async () => ((await (await treeRoutes(deps).POST(post(b))).json()) as { code?: string }).code };
  },
  "tree-photo": () => {
    const ts = Date.now();
    const change = { action: "photo" as const, person: wallet, photo: null };
    const b = { ...change, ...signed(ts, treeMessage("photo", estate, wallet, ts, sha(treeBody(change)))) };
    return { sig: b.sig, run: async () => ((await (await photoRoutes(deps).POST(post(b))).json()) as { code?: string }).code };
  },
  letters: () => {
    const ts = Date.now();
    const b = { action: "list", ...signed(ts, letterMessage("list", estate, wallet, ts, sha(LIST_BODY))) };
    const routes = () => lettersRoutes({ chain: () => true, now: () => Date.now(), snapshot: async () => null });
    return { sig: b.sig, run: async () => ((await (await routes().POST(post(b))).json()) as { code?: string }).code };
  },
  legacy: () => {
    const ts = Date.now();
    const sig = sign(authMessage("book.read", estate, wallet, ts, sha("")));
    const req = () => new Request("http://t/api", { headers: { [AUTH_HEADER]: encodeAuth({ estate, wallet, ts, sig }) } });
    return { sig, run: () => authorize(req(), "book.read", sha("")).then(() => undefined, (e: { code?: string }) => e.code) };
  },
  media: () => {
    const ts = Date.now();
    const sig = sign(mediaAuthMessage("photos.delete", estate, wallet, ts, sha("")));
    const req = () => new Request("http://t/api", { headers: { [AUTH_HEADER]: encodeAuth({ estate, wallet, ts, sig }) } });
    return { sig, run: () => authorizeOwner(req(), "photos.delete", sha(""), claim).then(() => undefined, (e: { code?: string }) => e.code) };
  },
};

beforeEach(() => {
  h.used.clear();
  Object.assign(h, { claimed: [], takes: [], taken: null });
});

describe("single use across instances", () => {
  it.each(Object.keys(requests))("%s refuses what another instance already took", async (scope) => {
    const r = requests[scope]();
    h.used.add(`once:${scope}:${r.sig}`);
    expect(await r.run()).toBe("replay");
    expect(h.claimed).toEqual([`once:${scope}:${r.sig}`]);
  });

  it.each(Object.keys(requests))("%s takes it once here", async (scope) => {
    const r = requests[scope]();
    expect(await r.run()).not.toBe("replay");
    expect(await r.run()).toBe("replay");
  });
});

describe("the voice's daily allowance", () => {
  it("is the estate's on every instance", async () => {
    h.taken = { ok: false, retryAfterSecs: 60 };
    await expect(countSpeak("some estate")).rejects.toMatchObject({ status: 429 });
    expect(h.takes).toEqual([{ key: "legacy-speak:some estate", max: 200, windowSecs: 86_400 }]);
  });
});

describe("every costly or signed route uses the shared store", () => {
  const root = path.resolve(process.cwd(), "src");
  const source = (file: string) => readFileSync(path.join(root, file), "utf8");
  const all = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));

  it.each([
    ["app/api/will-chat/route.ts", "will-chat"], ["app/api/agent/orchestrate/route.ts", "orchestrate-"], ["app/api/valuation/route.ts", "valuation"],
    ["app/api/invoice/route.ts", "invoice"], ["app/api/rank-offers/route.ts", "rank-offers"], ["app/api/assistant/qvac/route.ts", "assistant-qvac"],
    ["app/api/voice/session/route.ts", "voice-session"], ["app/api/legacy/speak/route.ts", "legacy-speak"],
    ["app/api/legacy/voice/route.ts", "legacy-voice-create"], ["app/api/legacy/demo-voice/route.ts", "legacy-demo-voice"],
    ["app/api/review/route.ts", "review"], ["app/api/sponsor/route.ts", "sponsor"], ["lib/letters/server/review-route.ts", "letters-review"],
  ])("%s", (file, bucket) => {
    expect(source(file)).toMatch(new RegExp(`await rateLimitShared\\(req, [\`"]${bucket}`));
  });

  it("no route keeps used signatures in a store of its own", () => {
    for (const f of all.filter((x) => /[\\/]server[\\/]|route\.ts$/.test(x))) {
      expect(source(f), f).not.toMatch(/seen\.(has|set)\((\w+\.)?sig/);
    }
  });

  it("nonces, shared allowances and the sponsor's allowance are always awaited", () => {
    const CALL = /\b(firstUse|countSpeak|spendSponsorAllowance|chainBackstop|takeShared|rateLimitShared)\(/;
    let calls = 0;
    for (const f of all) {
      for (const line of source(f).split("\n")) {
        if (!CALL.test(line) || /\bfunction\b|^\s*(\*|\/\/|\/\*\*)/.test(line)) continue;
        calls++;
        expect(line, f).toMatch(/await (\w+\.)?(firstUse|countSpeak|spendSponsorAllowance|chainBackstop|takeShared|rateLimitShared)\(/);
      }
    }
    expect(calls).toBeGreaterThan(25);
  });
});
