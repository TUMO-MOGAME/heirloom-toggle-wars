/**
 * /api/assets/photos route checks. Demo mode (LEGACY_DEMO_WRITES=1, memory store) for the upload rules; chain mode
 * with a mocked on-chain snapshot for the signature, owner and Active-estate checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import sharp from "sharp";
import { sha256Hex } from "@/lib/agent/hash";
import { AUTH_HEADER, encodeAuth, manifestText, mediaAuthMessage, type UploadManifest } from "./api";
import { isWebp, MAX_ORIGINAL_BYTES, MAX_PHOTO_BYTES } from "./webp";
import { mediaRootHex } from "@/lib/assets/spec";

/** Media root of unlabelled photos with no spec sheet. */
const photosRoot = (hashes: string[]) => mediaRootHex(hashes.map((sha256) => ({ sha256 })));
import { fakeWebp } from "./test-fixtures";
import { resetMemPhotos } from "./server/store";

const snapshot = { current: null as null | { estate: { owner: string; status: string }; assets: { address: string }[] } };
vi.mock("@/lib/server/estate", () => ({
  loadSnapshot: async () => { if (!snapshot.current) throw new Error("not found"); return snapshot.current; },
}));

const estate = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
const owner = "ThAbo1111111111111111111111111111111111111aa";
const asset = "AsSeT1111111111111111111111111111111111111aa";

beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock");
  vi.stubEnv("LEGACY_DEMO_WRITES", "1");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
});
afterAll(() => { vi.unstubAllEnvs(); });
beforeEach(() => resetMemPhotos());

let ip = 0;
const demoAuth = (role: "owner" | "child" = "owner") => ({
  [AUTH_HEADER]: encodeAuth({ estate, wallet: owner, ts: Date.now(), sig: "demo", demoRole: role }),
  "x-forwarded-for": `10.1.0.${++ip}`,
});

async function upload(photos: Uint8Array[], over: Partial<UploadManifest> = {}, headers: Record<string, string> = demoAuth(), filesOverride?: string[], type = "image/webp") {
  const files = filesOverride ?? await Promise.all(photos.map((p) => sha256Hex(p)));
  const m: UploadManifest = { asset, kind: "Furniture", title: "Oak dining table", order: files, files, ...over };
  const form = new FormData();
  form.set("manifest", manifestText(m));
  photos.forEach((p, i) => form.append("photos", new Blob([p as BlobPart], { type }), `p${i}.webp`));
  const { POST } = await import("@/app/api/assets/photos/route");
  return POST(new Request("http://x/api/assets/photos", { method: "POST", headers, body: form }));
}
const err = async (r: Response) => ((await r.json()) as { error: string }).error;

describe("/api/assets/photos (demo mode)", () => {
  it("GET without an estate reports availability; with one lists the photos for anyone", async () => {
    const { GET } = await import("@/app/api/assets/photos/route");
    expect(await (await GET(new Request("http://x/api/assets/photos"))).json()).toEqual({ available: true });
    const a = fakeWebp(800, 600, 400, 1);
    expect((await upload([a])).status).toBe(200);
    const list = await (await GET(new Request(`http://x/api/assets/photos?estate=${estate}`, { headers: { "x-forwarded-for": "10.9.9.9" } }))).json() as { assets: { asset: string; photos: { url: string; sha256: string }[]; photosRoot: string }[] };
    expect(list.assets).toHaveLength(1);
    expect(list.assets[0].photos[0].url).toMatch(/^\/api\/assets\/photos\/file\?p=/);
    expect(list.assets[0].photosRoot).toBe(await photosRoot([await sha256Hex(a)]));
    expect((await GET(new Request("http://x/api/assets/photos?estate=bad!"))).status).toBe(400);
  });

  it("stores WebP photos in order, returns sha256s and the root, and serves the bytes", async () => {
    const a = fakeWebp(1600, 1200, 500, 1), b = fakeWebp(1200, 1600, 600, 2);
    const r = await upload([a, b]);
    expect(r.status).toBe(200);
    const info = await r.json() as { photos: { sha256: string; url: string; width: number; height: number; bytes: number }[]; photosRoot: string; kind: string };
    const [ha, hb] = [await sha256Hex(a), await sha256Hex(b)];
    expect(info.photos.map((p) => p.sha256)).toEqual([ha, hb]);
    expect(info.photos[0]).toMatchObject({ width: 1600, height: 1200, bytes: 500 }); // size read from the WebP header
    expect(info.photosRoot).toBe(await photosRoot([ha, hb]));
    expect(info.kind).toBe("Furniture");
    const { GET: file } = await import("@/app/api/assets/photos/file/route");
    const res = await file(new Request(`http://x${info.photos[1].url}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(b);
    expect((await file(new Request("http://x/api/assets/photos/file?p=../../etc/passwd"))).status).toBe(404);
    const tampered = info.photos[1].url.replace(/s=[0-9a-f]{4}/, "s=0000");
    expect((await file(new Request(`http://x${tampered}`))).status).toBe(404); // signature checked
    const unsigned = info.photos[1].url.replace(/&e=.*$/, "");
    expect((await file(new Request(`http://x${unsigned}`))).status).toBe(404);
  });

  it("rejects anything that is not WebP by its bytes, whatever the content type says", async () => {
    const gif = new Uint8Array(400); gif.set(Array.from("GIF89a", (c) => c.charCodeAt(0))); // labelled image/webp below
    const r = await upload([gif]);
    expect(r.status).toBe(400); expect(await err(r)).toMatch(/not a WebP/);
  });

  it("enforces 1.5 MB per photo, 24 photos per asset, 1600 px and the signed list", async () => {
    expect((await upload([fakeWebp(800, 600, MAX_PHOTO_BYTES + 1)])).status).toBe(413);
    const many = Array.from({ length: 25 }, (_, i) => fakeWebp(100, 100, 64, i));
    expect((await upload(many)).status).toBe(400);
    const max = await upload(many.slice(0, 24));
    expect(max.status).toBe(200);
    expect(((await max.json()) as { photos: unknown[] }).photos).toHaveLength(24);
    expect(await err(await upload([fakeWebp(2000, 1000, 300)]))).toMatch(/1600 pixels/);
    const a = fakeWebp(800, 600, 300, 7);
    expect(await err(await upload([a], {}, demoAuth(), ["0".repeat(64)]))).toMatch(/signed list/);
    expect(await err(await upload([], { order: ["1".repeat(64)], files: [] }))).toMatch(/never uploaded/);
  });

  it("is owner only", async () => {
    const r = await upload([fakeWebp()], {}, demoAuth("child"));
    expect(r.status).toBe(403);
  });

  it("batches add to the set; reordering and leaving a photo out deletes it; DELETE removes one", async () => {
    const a = fakeWebp(800, 600, 300, 1), b = fakeWebp(800, 600, 300, 2), c = fakeWebp(800, 600, 300, 3);
    const [ha, hb, hc] = await Promise.all([a, b, c].map((x) => sha256Hex(x)));
    await upload([a, b]);
    let info = await (await upload([c], { order: [hc, ha, hb], files: [hc] })).json() as { photos: { sha256: string; url: string }[] };
    expect(info.photos.map((p) => p.sha256)).toEqual([hc, ha, hb]);
    const aUrl = info.photos[1].url;
    info = await (await upload([], { order: [hb, hc], files: [] })).json() as typeof info;
    expect(info.photos.map((p) => p.sha256)).toEqual([hb, hc]);
    const { GET: file } = await import("@/app/api/assets/photos/file/route");
    expect((await file(new Request(`http://x${aUrl}`))).status).toBe(404); // left out → deleted

    const { DELETE } = await import("@/app/api/assets/photos/route");
    const del = (sha: string, role: "owner" | "child" = "owner") => DELETE(new Request("http://x", { method: "DELETE", headers: { ...demoAuth(role), "content-type": "application/json" }, body: JSON.stringify({ asset, sha256: sha }) }));
    expect((await del(hb, "child")).status).toBe(403);
    const left = await (await del(hb)).json() as { photos: { sha256: string }[]; photosRoot: string };
    expect(left.photos.map((p) => p.sha256)).toEqual([hc]);
    expect(left.photosRoot).toBe(await photosRoot([hc]));
    expect((await del(hb)).status).toBe(404);
  });
});

describe("/api/assets/photos server conversion (browsers that cannot encode WebP)", () => {
  /** A 2000 x 1000 JPEG with EXIF (camera, GPS-like comment) and orientation 6 (rotate 90° on display). */
  const jpeg = () => sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: "TestCam", Model: "Phone 1" }, IFD3: { GPSLatitudeRef: "S", GPSLatitude: "33/1 55/1 0/1" } })
    .toBuffer().then((b) => new Uint8Array(b));

  it("converts a JPEG to WebP: EXIF rotation applied, ≤ 1600 px, all metadata stripped; only the WebP is stored", async () => {
    const original = await jpeg();
    const meta = await sharp(original).metadata();
    expect(meta.exif).toBeDefined(); expect(meta.orientation).toBe(6); // the fixture really carries EXIF
    const r = await upload([original], {}, demoAuth(), undefined, "image/jpeg");
    expect(r.status).toBe(200);
    const info = await r.json() as { photos: { sha256: string; url: string; width: number; height: number; bytes: number }[]; photosRoot: string };
    const p = info.photos[0];
    expect(p).toMatchObject({ width: 800, height: 1600 }); // rotated upright, then fitted inside 1600
    expect(p.sha256).not.toBe(await sha256Hex(original));   // the signed manifest named the original…
    const { GET: file } = await import("@/app/api/assets/photos/file/route");
    const stored = new Uint8Array(await (await file(new Request(`http://x${p.url}`))).arrayBuffer());
    expect(isWebp(stored)).toBe(true);
    expect(p.sha256).toBe(await sha256Hex(stored));          // …the response and the root use the stored WebP
    expect(p.bytes).toBe(stored.length);
    expect(info.photosRoot).toBe(await photosRoot([p.sha256]));
    const out = await sharp(stored).metadata();
    expect(out.format).toBe("webp");
    expect(out.exif).toBeUndefined(); expect(out.icc).toBeUndefined(); expect(out.xmp).toBeUndefined();
    expect(out.orientation).toBeUndefined();

    // A later batch names the converted photo by its WebP hash (as the client does after the response).
    const b = fakeWebp(800, 600, 300, 5); const hb = await sha256Hex(b);
    const next = await (await upload([b], { order: [hb, p.sha256], files: [hb] })).json() as { photos: { sha256: string }[] };
    expect(next.photos.map((x) => x.sha256)).toEqual([hb, p.sha256]);
  });

  it("checks originals by magic bytes and size, and refuses unreadable ones", async () => {
    const fakeJpeg = new Uint8Array(500); fakeJpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const r = await upload([fakeJpeg], {}, demoAuth(), undefined, "image/jpeg");
    expect(r.status).toBe(400); expect(await err(r)).toMatch(/could not be read/);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>".padEnd(300, " "));
    expect(await err(await upload([svg], {}, demoAuth(), undefined, "image/jpeg"))).toMatch(/not a WebP, JPEG, PNG, HEIC or AVIF/);
    const big = new Uint8Array(MAX_ORIGINAL_BYTES + 1); big.set([0xff, 0xd8, 0xff, 0xe0]);
    expect((await upload([big], {}, demoAuth(), undefined, "image/jpeg")).status).toBe(413);
  });
});

describe("/api/assets/photos labels and spec sheet", () => {
  const spec = { make: "Toyota", model: "Corolla", year: 2017, mileageKm: 124455, transmission: "Automatic" as const, spareKey: false };

  it("stores a label per photo and the spec sheet; both are part of the root", async () => {
    const a = fakeWebp(800, 600, 300, 21), b = fakeWebp(800, 600, 300, 22);
    const [ha, hb] = await Promise.all([a, b].map((x) => sha256Hex(x)));
    const r = await upload([a, b], { kind: "Car", labels: ["Front", "Engine"], spec });
    expect(r.status).toBe(200);
    const info = await r.json() as { photos: { sha256: string; label?: string }[]; spec: unknown; photosRoot: string };
    expect(info.photos.map((p) => p.label)).toEqual(["Front", "Engine"]);
    expect(info.spec).toEqual(spec);
    expect(info.photosRoot).toBe(await mediaRootHex([{ sha256: ha, label: "Front" }, { sha256: hb, label: "Engine" }], spec));
    expect(info.photosRoot).not.toBe(await photosRoot([ha, hb]));
    // Relabel without re-sending the photos; drop the spec sheet.
    const again = await (await upload([], { order: [ha, hb], files: [], labels: ["Front", ""], spec: null })).json() as { photos: { label?: string }[]; spec?: unknown; photosRoot: string };
    expect(again.photos.map((p) => p.label)).toEqual(["Front", undefined]);
    expect(again.spec).toBeUndefined();
    expect(again.photosRoot).toBe(await mediaRootHex([{ sha256: ha, label: "Front" }, { sha256: hb }]));
  });

  it("refuses unknown labels, a label list of the wrong length and an invalid spec sheet", async () => {
    const a = fakeWebp(800, 600, 300, 23);
    expect((await upload([a], { labels: ["Roof" as never] })).status).toBe(400);
    expect(await err(await upload([a], { labels: ["Front", "Rear"] }))).toMatch(/one label/);
    expect((await upload([a], { spec: { year: 1800 } as never })).status).toBe(400);
    expect((await upload([a], { spec: { colour: "Silver", owner: "Thabo" } as never })).status).toBe(400);
    // The test asset is furniture: vehicle fields do not belong on its sheet, furniture fields do.
    expect(await err(await upload([a], { spec: { material: "Oak", mileageKm: 10 } }))).toMatch(/do not belong.*mileageKm/);
    expect((await upload([a], { spec: { material: "Oak", pieces: 7 } })).status).toBe(200);
  });

  it("converts an AVIF original to WebP on the server", async () => {
    const avif = new Uint8Array(await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#7a8a99" } }).avif({ quality: 50 }).toBuffer());
    const r = await upload([avif], { labels: ["Side"] }, demoAuth(), undefined, "image/avif");
    expect(r.status).toBe(200);
    const info = await r.json() as { photos: { width: number; height: number; label?: string }[] };
    expect(info.photos[0]).toMatchObject({ width: 1600, height: 1200, label: "Side" });
  });
});

describe("/api/assets/photos (chain mode: signed by the owner)", () => {
  const keys = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(keys.publicKey.export({ format: "der", type: "spki" }).subarray(12));
  const other = generateKeyPairSync("ed25519");

  beforeAll(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "chain"); });
  afterAll(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock"); });

  async function signed(photo: Uint8Array, key = keys.privateKey, ts = Date.now()) {
    const h = await sha256Hex(photo);
    const m: UploadManifest = { asset, kind: "Jewellery", title: "Gold watch", order: [h], files: [h] };
    const sig = edSign(null, Buffer.from(mediaAuthMessage("photos.upload", estate, wallet, ts, await sha256Hex(manifestText(m)))), key).toString("hex");
    return upload([photo], m, { [AUTH_HEADER]: encodeAuth({ estate, wallet, ts, sig }), "x-forwarded-for": `10.2.0.${++ip}` });
  }

  it("accepts the owner's signature on an Active estate", async () => {
    snapshot.current = { estate: { owner: wallet, status: "Active" }, assets: [{ address: asset }] };
    expect((await signed(fakeWebp(640, 480, 300, 11))).status).toBe(200);
  });

  it("refuses demo signatures, wrong keys, stale requests, non-owners, unlocked estates and unknown assets", async () => {
    snapshot.current = { estate: { owner: wallet, status: "Active" }, assets: [{ address: asset }] };
    expect((await upload([fakeWebp()], {}, demoAuth())).status).toBe(401);
    expect((await signed(fakeWebp(640, 480, 300, 12), other.privateKey)).status).toBe(401);
    expect((await signed(fakeWebp(640, 480, 300, 13), keys.privateKey, Date.now() - 10 * 60_000)).status).toBe(401);
    snapshot.current = { estate: { owner: owner, status: "Active" }, assets: [{ address: asset }] };
    expect((await signed(fakeWebp(640, 480, 300, 14))).status).toBe(403);
    snapshot.current = { estate: { owner: wallet, status: "Unlocked" }, assets: [{ address: asset }] };
    expect((await signed(fakeWebp(640, 480, 300, 15))).status).toBe(409);
    snapshot.current = { estate: { owner: wallet, status: "Active" }, assets: [] };
    expect((await signed(fakeWebp(640, 480, 300, 16))).status).toBe(404);
  });
});
