/**
 * Plan §18.9 H5: any wallet could write tree photos and hide flags, and at the limits (200 photos, 500 rows) a new
 * write pushed out a family's own. Now: members only, nothing stored is ever pushed out, and the GET stays under
 * Vercel's 4.5 MB response limit. Real signatures, the real routes over server memory (Supabase off).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type { Raw } from "@/lib/chain/decoders";
import { treeBody, treeMessage } from "../links";
import { webpOf } from "../photo-fixture";
import { PHOTO_MAX_BYTES } from "../photos";
import { photoRoutes } from "./photo-route";
import { treeRoutes } from "./route";
import { MAX_PER_ESTATE, MAX_PHOTO_CHARS, MAX_PHOTOS, getPhotos, putPhoto, resetTreeMemory, setHiddenFlag } from "./store";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  return { address, sign: (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}
type W = ReturnType<typeof wallet>;
const E = bs58.encode(Buffer.alloc(32, 9));
const owner = wallet(), child = wallet(), stranger = wallet();
const members = new Set([owner.address, child.address]);
const deps = {
  fetchRaw: async (_type: string, address: string) => (address === E ? ({ owner: new PublicKey(owner.address) } as Raw) : null),
  memberOf: async (_e: string, w: string) => members.has(w),
  now: () => Date.now(),
  chain: () => true,
};
let ts = Date.now();

function photoBody(w: W, person: string, photo: string | null) {
  const at = ++ts;
  return { action: "photo", estate: E, wallet: w.address, ts: at, person, photo, sig: w.sign(treeMessage("photo", E, w.address, at, sha(treeBody({ action: "photo", person, photo })))) };
}
function hideBody(w: W, hidden: boolean) {
  const at = ++ts;
  return { action: "hide", estate: E, wallet: w.address, ts: at, hidden, sig: w.sign(treeMessage("hide", E, w.address, at, sha(treeBody({ action: "hide", hidden })))) };
}
const post = async (r: { POST(req: Request): Promise<Response> }, body: unknown) => {
  const res = await r.POST(new Request("http://t/api/tree", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `10.1.${++ts % 250}.1` } }));
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
};

beforeEach(() => resetTreeMemory());

describe("only the family writes to its tree", () => {
  it("a stranger can't set their photo on it, and can't hide on it", async () => {
    expect(await post(photoRoutes(deps), photoBody(stranger, stranger.address, webpOf(500)))).toEqual({ status: 403, code: "members_only" });
    expect(await post(treeRoutes(deps), hideBody(stranger, true))).toEqual({ status: 403, code: "members_only" });
    expect(await getPhotos(E)).toEqual({ photos: {} });
  });

  it("a member can", async () => {
    expect((await post(photoRoutes(deps), photoBody(child, child.address, webpOf(500)))).status).toBe(200);
    expect((await post(treeRoutes(deps), hideBody(child, false))).status).toBe(200);
  });

  it("by default membership is read from the chain with the route's own reader", async () => {
    const { memberOf: _m, ...chainOnly } = deps;
    void _m;
    // The estate account names `owner` and nobody else, so only the owner is family.
    expect((await post(photoRoutes(chainOnly), photoBody(child, child.address, webpOf(500)))).code).toBe("members_only");
    expect((await post(photoRoutes(chainOnly), photoBody(owner, owner.address, webpOf(500)))).status).toBe(200);
  });
});

describe("nothing stored is pushed out", () => {
  it("at 200 photos a new person is refused, the family's photos all stay, and a change to one still works", async () => {
    for (let i = 0; i < MAX_PHOTOS; i++) await putPhoto(E, `local:p${i}`, { src: webpOf(100), by: owner.address, at: i });
    expect(await post(photoRoutes(deps), photoBody(owner, "local:one-more", webpOf(100)))).toEqual({ status: 409, code: "full" });
    expect(Object.keys((await getPhotos(E)).photos)).toHaveLength(MAX_PHOTOS);
    expect((await post(photoRoutes(deps), photoBody(owner, "local:p0", webpOf(200)))).status).toBe(200);
  });

  it("at 500 hide flags a new wallet is refused and the others keep theirs", async () => {
    for (let i = 0; i < MAX_PER_ESTATE; i++) await setHiddenFlag(E, `w${i}`, true, 1);
    expect(await post(treeRoutes(deps), hideBody(child, true))).toEqual({ status: 409, code: "full" });
  });
});

describe("the GET fits a function response", () => {
  it("the photos a family can store come to less than 4.5 MB", async () => {
    const big = webpOf(PHOTO_MAX_BYTES);
    let refused = 0;
    for (let i = 0; i < MAX_PHOTOS; i++) {
      await putPhoto(E, `local:p${i}`, { src: big, by: owner.address, at: i }).catch(() => { refused++; });
    }
    expect(refused).toBeGreaterThan(0);
    const body = JSON.stringify(await getPhotos(E));
    expect(body.length).toBeLessThan(4_500_000);
    expect(MAX_PHOTO_CHARS).toBeLessThan(4_500_000);
  });
});
