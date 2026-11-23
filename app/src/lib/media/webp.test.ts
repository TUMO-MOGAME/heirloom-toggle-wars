import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { convertToWebp, preparePhoto, sniffImage, EMPTY_ROOT, fitWithin, isWebp, MAX_PHOTO_BYTES, photosRoot, webpSize, WebpError, type DecodedImage, type WebpEncoder } from "./webp";
import { fakeWebp } from "./test-fixtures";

const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const png = () => { const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("isWebp (magic bytes)", () => {
  it("accepts RIFF....WEBP with a VP8 / VP8L / VP8X chunk", () => {
    expect(isWebp(fakeWebp())).toBe(true);
    for (const tag of ["VP8L", "VP8X"]) { const b = fakeWebp(); b.set(enc(tag), 12); expect(isWebp(b)).toBe(true); }
  });
  it("rejects PNG, JPEG, other RIFF files, truncated and empty input", () => {
    expect(isWebp(png())).toBe(false);
    expect(isWebp(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]))).toBe(false);
    const wav = fakeWebp(); wav.set(enc("WAVE"), 8); expect(isWebp(wav)).toBe(false);
    const odd = fakeWebp(); odd.set(enc("ABCD"), 12); expect(isWebp(odd)).toBe(false);
    expect(isWebp(fakeWebp().subarray(0, 12))).toBe(false);
    expect(isWebp(new Uint8Array())).toBe(false);
  });
});

describe("webpSize", () => {
  it("reads lossy (VP8), extended (VP8X) and lossless (VP8L) sizes", () => {
    expect(webpSize(fakeWebp(1600, 1200))).toEqual({ width: 1600, height: 1200 });
    const x = fakeWebp(); x.set(enc("VP8X"), 12); x.set([0x3f, 0x06, 0x00], 24); x.set([0xaf, 0x04, 0x00], 27);
    expect(webpSize(x)).toEqual({ width: 1600, height: 1200 });
    const l = fakeWebp(); l.set(enc("VP8L"), 12); l[20] = 0x2f;
    const bits = (640 - 1) | ((480 - 1) << 14);
    l.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 21);
    expect(webpSize(l)).toEqual({ width: 640, height: 480 });
  });
  it("returns null for a VP8 chunk without the key-frame start code", () => {
    const b = fakeWebp(); b[23] = 0; expect(webpSize(b)).toBeNull();
  });
});

describe("photosRoot", () => {
  const a = sha(new Uint8Array([1])), b = sha(new Uint8Array([2]));
  it("is SHA-256 of the raw digests concatenated in order", async () => {
    const expected = createHash("sha256").update(Buffer.concat([Buffer.from(a, "hex"), Buffer.from(b, "hex")])).digest("hex");
    expect(await photosRoot([a, b])).toBe(expected);
    expect(await photosRoot([b, a])).not.toBe(expected); // order matters
    expect(await photosRoot([a.toUpperCase(), b])).toBe(expected);
  });
  it("uses the all-zero root for no photos and rejects bad hashes", async () => {
    expect(await photosRoot([])).toBe(EMPTY_ROOT);
    await expect(photosRoot(["abc"])).rejects.toThrow(/SHA-256/);
  });
});

describe("fitWithin", () => {
  it("caps the long edge at 1600 px and never upscales", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(() => fitWithin(0, 10)).toThrow();
  });
});

describe("convertToWebp (fake canvas)", () => {
  const photo = (type = "image/jpeg") => new File([new Uint8Array(5000)], "IMG_0001.jpg", { type });
  /** Fake encoder: records the requested sizes and returns `out(w, h, q)`. */
  const fake = (w: number, h: number, out: (w: number, h: number, q: number) => Uint8Array | null, calls: number[][] = []): WebpEncoder => ({
    async load(): Promise<DecodedImage> {
      return {
        width: w, height: h,
        async render(rw, rh, type, q) { calls.push([rw, rh, q]); expect(type).toBe("image/webp"); const b = out(rw, rh, q); return b ? new Blob([b as BlobPart], { type: "image/webp" }) : null; },
        release() { calls.push([-1]); },
      };
    },
  });

  it("resizes to 1600 px, returns size, bytes and the SHA-256 of the WebP", async () => {
    const calls: number[][] = [];
    const r = await convertToWebp(photo(), fake(4032, 3024, (w, h) => fakeWebp(w, h, 1000), calls));
    expect(r).toMatchObject({ width: 1600, height: 1200, bytes: 1000 });
    expect(r.sha256).toBe(sha(fakeWebp(1600, 1200, 1000)));
    expect(r.blob.type).toBe("image/webp");
    expect(calls[0]).toEqual([1600, 1200, 0.82]);
    expect(calls.at(-1)).toEqual([-1]); // released
  });

  it("refuses a browser that hands back PNG instead of WebP", async () => {
    await expect(convertToWebp(photo(), fake(800, 600, () => png()))).rejects.toMatchObject({ code: "unsupported" });
    await expect(convertToWebp(photo(), fake(800, 600, () => null))).rejects.toBeInstanceOf(WebpError);
  });

  it("retries at lower quality, then smaller, when over 1.5 MB", async () => {
    const calls: number[][] = [];
    const r = await convertToWebp(photo(), fake(4000, 3000, (w, h, q) => fakeWebp(w, h, q > 0.6 || w > 1200 ? MAX_PHOTO_BYTES + 10 : 2000), calls));
    expect(r.width).toBe(1200);
    expect(calls.slice(0, 4).map((c) => c[2])).toEqual([0.82, 0.72, 0.6, 0.6]);
    await expect(convertToWebp(photo(), fake(4000, 3000, (w, h) => fakeWebp(w, h, MAX_PHOTO_BYTES + 1)))).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects non-images and undecodable files with plain messages", async () => {
    await expect(convertToWebp(new File(["x"], "notes.pdf", { type: "application/pdf" }), fake(1, 1, () => null))).rejects.toMatchObject({ code: "not_image" });
    const broken: WebpEncoder = { load: () => Promise.reject(new Error("bad")) };
    await expect(convertToWebp(new File([new Uint8Array(10)], "IMG.HEIC", { type: "" }), broken)).rejects.toMatchObject({ code: "decode" });
  });
});

describe("sniffImage (originals for server conversion)", () => {
  it("recognises JPEG, PNG and HEIC/HEIF by magic bytes only", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(sniffImage(png())).toBe("png");
    const heic = new Uint8Array(16); heic.set(Array.from("....ftypheic", (c) => c.charCodeAt(0)));
    expect(sniffImage(heic)).toBe("heif");
    for (const brand of ["avif", "avis"]) {
      const avif = new Uint8Array(16); avif.set(Array.from(`....ftyp${brand}`, (c) => c.charCodeAt(0)));
      expect(sniffImage(avif)).toBe("avif");
    }
    expect(sniffImage(fakeWebp())).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("preparePhoto (browser cannot encode WebP)", () => {
  const jpeg = (n = 3000) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
  const photo = () => new File([jpeg() as BlobPart], "IMG_0001.HEIC", { type: "image/heic" });
  /** Like Safari: WebP requests come back as PNG; JPEG requests work. */
  const safari = (calls: string[] = []): WebpEncoder => ({
    async load(): Promise<DecodedImage> {
      return {
        width: 4032, height: 3024,
        async render(_w, _h, type) { calls.push(type); return new Blob([(type === "image/jpeg" ? jpeg(900) : png()) as BlobPart], { type: type === "image/jpeg" ? type : "image/png" }); },
        release() {},
      };
    },
  });

  it("uses WebP when the browser can make it", async () => {
    const ok: WebpEncoder = { async load() { return { width: 800, height: 600, render: async (w, h) => new Blob([fakeWebp(w, h, 500) as BlobPart]), release() {} }; } };
    expect((await preparePhoto(photo(), ok)).kind).toBe("new");
  });

  it("falls back to a canvas JPEG at 1600 px for the server to convert", async () => {
    const calls: string[] = [];
    const r = await preparePhoto(photo(), safari(calls));
    expect(r.kind).toBe("raw");
    expect(r.photo).toMatchObject({ width: 1600, height: 1200, bytes: 900 });
    expect(r.photo.sha256).toBe(sha(jpeg(900)));
    expect(calls.at(-1)).toBe("image/jpeg");
  });

  it("sends the original when the canvas cannot help, if it is a JPEG/PNG/HEIC", async () => {
    const broken: WebpEncoder = { load: () => Promise.reject(new Error("no decoder")) };
    await expect(preparePhoto(photo(), broken)).rejects.toMatchObject({ code: "decode" }); // undecodable: not "unsupported"
    const pngOnly: WebpEncoder = { async load() { return { width: 10, height: 10, render: async () => new Blob([png() as BlobPart]), release() {} }; } };
    const r = await preparePhoto(photo(), pngOnly);
    expect(r).toMatchObject({ kind: "raw", photo: { bytes: 3000, sha256: sha(jpeg()) } });
    await expect(preparePhoto(new File([new Uint8Array(64) as BlobPart], "x.jpg", { type: "image/jpeg" }), pngOnly)).rejects.toMatchObject({ code: "unsupported" });
  });
});
