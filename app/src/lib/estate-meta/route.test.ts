/**
 * POST /api/estate-meta (bug 5, 22 Nov 2026): names are saved only with the estate owner's signature, a buyer may give
 * only their own name, and a signed request can't be replayed. Deps injected, real ed25519 signatures.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { estateMetaRoutes, type EstateMetaRouteDeps } from "./route";
import { metaBody, metaMessage, signedMetaRequest, type MetaAction } from "./signed";
import { hashJson } from "../agent/hash";
import type { EstateMeta } from "../db";
import type { WillDraft } from "../types";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}
type W = ReturnType<typeof wallet>;
const owner = wallet(), stranger = wallet(), buyer = wallet();
const E = "EsTaTeTeStAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CAR = "CaRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const names = { ownerName: "Thabo Mokoena", verifierNames: ["Adv. Ndlovu", "Ms. Pillay", "Uncle Bongani"] as [string, string, string], assetTitles: {}, buyerNames: {} };
let store: Map<string, EstateMeta>;
let drafts: string[];
let chain = true;
let clock = Date.UTC(2026, 10, 22, 10);
let willHash: string | null = null;
const offers = new Set<string>();
const deps: EstateMetaRouteDeps = {
  chain: () => chain, now: () => clock,
  estate: async (e) => (e === E ? { owner: owner.address, willHash } : null),
  hasOffer: async (e, asset, b) => e === E && offers.has(`${asset}:${b}`),
  get: async (e) => store.get(e) ?? null,
  save: async (m) => { store.set(m.estate, m); return true; },
  saveDraft: async (_o, _d, h) => { drafts.push(h); },
};
let routes = estateMetaRoutes(deps);
let n = 0;
const nextTs = () => clock + (++n % 10_000);

function signed(w: W, action: MetaAction, payload: Record<string, unknown>, at = nextTs(), estate = E) {
  const sig = w.sign(metaMessage(action, estate, w.address, at, sha(metaBody(payload))));
  return action === "save" ? { action, estate, wallet: w.address, ts: at, sig, meta: payload } : { action, estate, wallet: w.address, ts: at, sig, ...payload };
}
// A fresh client address per request, so the per-IP rate limit (10 writes a minute) doesn't trip the suite.
let ip = 0;
const post = (body: unknown) => routes.POST(new Request("http://local/api/estate-meta", { method: "POST", headers: { "x-forwarded-for": `10.0.0.${++ip}` }, body: JSON.stringify(body) }));
const status = async (body: unknown) => (await post(body)).status;
const code = async (body: unknown) => ((await (await post(body)).json()) as { code?: string }).code;

beforeEach(() => {
  store = new Map(); drafts = []; chain = true; willHash = null; offers.clear(); clock = Date.UTC(2026, 10, 22, 10);
  routes = estateMetaRoutes(deps);
});

describe("POST /api/estate-meta: save", () => {
  it("the owner's signed save is stored (happy path)", async () => {
    expect(await status(signed(owner, "save", names))).toBe(200);
    expect(store.get(E)).toMatchObject({ estate: E, ownerWallet: owner.address, ownerName: "Thabo Mokoena" });
  });

  it("the browser helper's request is accepted as is", async () => {
    const body = await signedMetaRequest({ address: owner.address, signMessage: async (m) => owner.sign(m) }, "save", E, names, clock);
    expect(await status(body)).toBe(200);
  });

  it("401 without a signature, or with one that doesn't match the body or the wallet", async () => {
    const good = signed(owner, "save", names);
    expect(await status({ ...good, sig: undefined })).toBe(400);
    expect(await code({ ...good, meta: { ...names, ownerName: "Someone Else" } })).toBe("unauthorized");
    expect(await code({ ...signed(stranger, "save", names), wallet: owner.address })).toBe("unauthorized");
    expect(store.size).toBe(0);
  });

  it("403 when anyone but the on-chain owner signs (the old hole: the owner's address is public)", async () => {
    const r = await post(signed(stranger, "save", { ...names, ownerName: "Renamed" }));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("forbidden");
    expect(store.size).toBe(0);
  });

  it("401 replay: the same signed request is refused the second time", async () => {
    const body = signed(owner, "save", names);
    expect(await status(body)).toBe(200);
    expect(await code(body)).toBe("replay");
  });

  it("401 stale: a request more than 5 minutes old (or ahead)", async () => {
    expect(await code(signed(owner, "save", names, clock - 6 * 60_000))).toBe("stale");
    expect(await code(signed(owner, "save", names, clock + 6 * 60_000))).toBe("stale");
  });

  it("409: an older save can't roll back a newer one", async () => {
    expect(await status(signed(owner, "save", { ...names, ownerName: "New" }, clock + 2000))).toBe(200);
    expect(await code(signed(owner, "save", { ...names, ownerName: "Old" }, clock + 1000))).toBe("stale");
    expect(store.get(E)?.ownerName).toBe("New");
  });

  it("404 for an estate that isn't on-chain; 503 on the demo deployment", async () => {
    expect(await status(signed(owner, "save", names, nextTs(), "NoSuChEsTaTeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"))).toBe(404);
    chain = false;
    expect(await status(signed(owner, "save", names))).toBe(503);
  });

  it("the will draft is kept only when it matches the signed will hash", async () => {
    const { cannedWillTurn } = await import("../agent/canned");
    const { willDraftSchema } = await import("../agent/schemas");
    const draft: WillDraft = cannedWillTurn(9).draft!;
    const parsed = willDraftSchema.safeParse(draft);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    willHash = await hashJson(parsed.data);
    expect(await status(signed(owner, "save", { ...names, draft: parsed.data }))).toBe(200);
    expect(drafts).toEqual([willHash]);
    willHash = "00".repeat(32);
    expect(await code(signed(owner, "save", { ...names, draft: parsed.data }))).toBe("will_hash");
  });
});

describe("POST /api/estate-meta: buyer-name", () => {
  beforeEach(async () => { expect(await status(signed(owner, "save", { ...names, buyerNames: { [stranger.address]: "Aunt Zodwa" } }))).toBe(200); });

  it("a buyer with an offer gives their own name", async () => {
    offers.add(`${CAR}:${buyer.address}`);
    const r = await post(signed(buyer, "buyer-name", { asset: CAR, name: "Pieter van Wyk" }));
    expect(r.status).toBe(200);
    expect(store.get(E)?.buyerNames[buyer.address]).toBe("Pieter van Wyk");
    expect(store.get(E)?.ownerName).toBe("Thabo Mokoena");
  });

  it("403 without an offer on the estate's asset", async () => {
    expect(await code(signed(buyer, "buyer-name", { asset: CAR, name: "Pieter" }))).toBe("no_offer");
    expect(store.get(E)?.buyerNames[buyer.address]).toBeUndefined();
  });

  it("never replaces a name the owner gave", async () => {
    offers.add(`${CAR}:${stranger.address}`);
    const r = await post(signed(stranger, "buyer-name", { asset: CAR, name: "Not Zodwa" }));
    expect(((await r.json()) as { saved: boolean }).saved).toBe(false);
    expect(store.get(E)?.buyerNames[stranger.address]).toBe("Aunt Zodwa");
  });

  it("401 when the name was changed after signing", async () => {
    offers.add(`${CAR}:${buyer.address}`);
    expect(await code({ ...signed(buyer, "buyer-name", { asset: CAR, name: "Pieter" }), name: "Owner" })).toBe("unauthorized");
  });
});

describe("GET /api/estate-meta", () => {
  it("refuses to save the redacted view over the real names", async () => {
    expect(await status(signed(owner, "save", names))).toBe(200);
    expect(await status(signed(owner, "save", { ...names, ownerName: "Estate owner" }))).toBe(409);
  });

  it("gives the family's names to members only; anyone else gets roles", async () => {
    expect(await status(signed(owner, "save", names))).toBe(200);
    const req = () => new Request(`http://local/api/estate-meta?estate=${E}`);
    const stranger = (await (await estateMetaRoutes({ ...deps, member: async () => null }).GET(req())).json()) as EstateMeta;
    expect(stranger.ownerName).toBe("Estate owner");
    expect(stranger.verifierNames).toEqual(["Verifier 1", "Verifier 2", "Verifier 3"]);
    expect(stranger.buyerNames).toEqual({});
    const member = (await (await estateMetaRoutes({ ...deps, member: async () => owner.address }).GET(req())).json()) as EstateMeta;
    expect(member.ownerName).toBe("Thabo Mokoena");
  });
});
