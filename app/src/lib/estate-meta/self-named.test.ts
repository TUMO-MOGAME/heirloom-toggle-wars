/**
 * Plan §18.9 (low): a buyer's self-chosen name became a trusted fact: the reviewer matched certificates against it, and
 * the Legacy Book matched a child by it. It is shown beside the offer still, but marked as the buyer's own, and the
 * mark survives the owner's saves until the owner gives that wallet a name. Real signatures, the real route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const { estateMetaRoutes } = await import("./route");
const { metaBody, metaMessage } = await import("./signed");
const { trustedNames } = await import("../db");
import type { EstateMeta } from "../db";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  return { address, sign: (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}
const owner = wallet(), buyer = wallet();
const E = "EsTaTeTeStAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CAR = "CaRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let store: Map<string, EstateMeta>;
let ts = Date.now();
const routes = () => estateMetaRoutes({
  chain: () => true, now: () => Date.now(),
  estate: async () => ({ owner: owner.address, willHash: null }),
  hasOffer: async () => true,
  get: async (e) => store.get(e) ?? null,
  save: async (m) => { store.set(m.estate, m); return true; },
  saveDraft: async () => undefined,
});
async function post(w: ReturnType<typeof wallet>, action: "save" | "buyer-name", payload: Record<string, unknown>) {
  const at = ++ts;
  const sig = w.sign(metaMessage(action, E, w.address, at, sha(metaBody(payload))));
  const body = action === "save" ? { action, estate: E, wallet: w.address, ts: at, sig, meta: payload } : { action, estate: E, wallet: w.address, ts: at, sig, ...payload };
  return routes().POST(new Request("http://t/api/estate-meta", { method: "POST", headers: { "x-forwarded-for": `10.5.0.${at % 250}` }, body: JSON.stringify(body) }));
}
const names = (buyerNames: Record<string, string>) =>
  ({ ownerName: "Thabo", verifierNames: ["A", "B", "C"], assetTitles: {}, buyerNames, basedOn: store.get(E)?.updatedAt ?? 0 });

beforeEach(() => {
  store = new Map([[E, { estate: E, ownerWallet: owner.address, ownerName: "Thabo", verifierNames: ["A", "B", "C"], assetTitles: {}, buyerNames: {}, updatedAt: 1 }]]);
});

describe("a buyer's own name", () => {
  it("is shown, but is not a name anyone can be trusted by", async () => {
    expect((await post(buyer, "buyer-name", { asset: CAR, name: "Sipho" })).status).toBe(200);
    const m = store.get(E)!;
    expect(m.buyerNames[buyer.address]).toBe("Sipho");
    expect(trustedNames(m)[buyer.address]).toBeUndefined();
  });

  it("stays untrusted when the owner's device saves the whole map back", async () => {
    await post(buyer, "buyer-name", { asset: CAR, name: "Sipho" });
    expect((await post(owner, "save", names({ ...store.get(E)!.buyerNames }))).status).toBe(200);
    expect(trustedNames(store.get(E))[buyer.address]).toBeUndefined();
  });

  it("becomes trusted only when the owner gives that wallet a name of their own", async () => {
    await post(buyer, "buyer-name", { asset: CAR, name: "Sipho" });
    await post(owner, "save", names({ [buyer.address]: "Sipho Dlamini (cousin)" }));
    expect(trustedNames(store.get(E))[buyer.address]).toBe("Sipho Dlamini (cousin)");
  });
});
