/** Photo consent, format checks and this device's copy (plan.md §15.11). */
import { describe, expect, it } from "vitest";
import { checkPhoto, mergePhotos, photoConsent, PHOTO_MAX_BYTES, readLocalPhotos, visiblePhoto, writeLocalPhotos, type PhotoSubject } from "./photos";
import { centreSquare } from "./photo-image";
import { webpOf } from "./photo-fixture";

const OWNER = "Owner11111111111111111111111111111111111111";
const ADULT = "Adult11111111111111111111111111111111111111";
const CHILD = "Child11111111111111111111111111111111111111";
const GONE = "Gone111111111111111111111111111111111111111";
const ORG = "Charity1111111111111111111111111111111111111";
const STRANGER = "Stranger111111111111111111111111111111111111";
const TODAY = 2026;

const who = (id: string, over: Partial<PhotoSubject> = {}): PhotoSubject => ({ id, wallets: id.startsWith("local:") ? [] : [id], hidden: false, ...over });

describe("photoConsent", () => {
  it("lets a living adult set only their own photo, the owner included", () => {
    expect(photoConsent(who(ADULT, { born: 1979 }), ADULT, false, TODAY)).toBe("own");
    expect(photoConsent(who(OWNER, { born: 1976 }), OWNER, true, TODAY)).toBe("own");
    // Nobody else, not even the estate owner.
    expect(photoConsent(who(ADULT, { born: 1979 }), OWNER, true, TODAY)).toBeNull();
    expect(photoConsent(who(ADULT), STRANGER, false, TODAY)).toBeNull();
  });

  it("lets the owner decide for a child, someone who has passed, someone without a wallet and an organisation", () => {
    expect(photoConsent(who(CHILD, { born: 2011 }), OWNER, true, TODAY)).toBe("owner");
    expect(photoConsent(who(GONE, { born: 1950, passed: 2020 }), OWNER, true, TODAY)).toBe("owner");
    expect(photoConsent(who("local:gogo-martha", { passed: 2019 }), OWNER, true, TODAY)).toBe("owner");
    expect(photoConsent(who("local:aunt-no-wallet"), OWNER, true, TODAY)).toBe("owner");
    expect(photoConsent(who(ORG, { org: true }), OWNER, true, TODAY)).toBe("owner");
  });

  it("does not let a child, a family member or anyone else do the owner's part", () => {
    expect(photoConsent(who(CHILD, { born: 2011 }), CHILD, false, TODAY)).toBeNull();
    expect(photoConsent(who(CHILD, { born: 2011 }), ADULT, false, TODAY)).toBeNull();
    expect(photoConsent(who("local:gogo-martha", { passed: 2019 }), ADULT, false, TODAY)).toBeNull();
    expect(photoConsent(who(ORG, { org: true }), ORG, false, TODAY)).toBeNull();
    // Someone who has passed cannot sign for themselves; a passing in the imagined future does not count yet.
    expect(photoConsent(who(GONE, { passed: 2020 }), GONE, false, TODAY)).toBeNull();
    expect(photoConsent(who(ADULT, { born: 1976, passed: 2041 }), ADULT, false, TODAY)).toBe("own");
    expect(photoConsent(who(CHILD, { born: 2011 }), null, false, TODAY)).toBeNull();
  });

  it("gives nobody a photo for a hidden person", () => {
    expect(photoConsent(who(ADULT, { hidden: true }), ADULT, false, TODAY)).toBeNull();
    expect(photoConsent(who(ADULT, { hidden: true }), OWNER, true, TODAY)).toBeNull();
    expect(visiblePhoto({ hidden: true }, { src: webpOf(100), by: ADULT, at: 1 })).toBeNull();
    expect(visiblePhoto({ hidden: false }, { src: webpOf(100), by: ADULT, at: 1 })).not.toBeNull();
  });
});

describe("checkPhoto", () => {
  it("accepts a WebP data URL up to 60 KB", () => {
    expect(checkPhoto(webpOf(2_000))).toBeNull();
    expect(checkPhoto(webpOf(PHOTO_MAX_BYTES))).toBeNull();
  });
  it("refuses anything larger", () => {
    expect(checkPhoto(webpOf(PHOTO_MAX_BYTES + 1))).toBe("size");
    expect(checkPhoto(webpOf(500_000))).toBe("size");
  });
  it("refuses other types, including a PNG or SVG dressed up as WebP", () => {
    const png = Buffer.from("\x89PNG\r\n\x1a\n0000000000", "latin1").toString("base64");
    expect(checkPhoto(`data:image/png;base64,${png}`)).toBe("type");
    expect(checkPhoto(`data:image/webp;base64,${png}`)).toBe("type");
    expect(checkPhoto("data:image/svg+xml,%3Csvg%3E")).toBe("type");
    expect(checkPhoto("https://example.com/me.webp")).toBe("type");
    expect(checkPhoto("data:image/webp;base64,not base64!")).toBe("type");
  });
});

describe("centreSquare", () => {
  it("crops the middle of a landscape or portrait photo", () => {
    expect(centreSquare(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(centreSquare(300, 500)).toEqual({ sx: 0, sy: 100, side: 300 });
  });
});

describe("this device's copy", () => {
  class Mem { data = new Map<string, string>(); getItem(k: string) { return this.data.get(k) ?? null; } setItem(k: string, v: string) { this.data.set(k, v); } }
  it("keeps set and removed photos per estate and lays them over the server's", () => {
    const m = new Mem();
    const mine = { src: webpOf(10), by: ADULT, at: 5 };
    writeLocalPhotos(m, "E1", (l) => ({ ...l, [ADULT]: mine, [CHILD]: null }));
    expect(readLocalPhotos(m, "E1")).toEqual({ [ADULT]: mine, [CHILD]: null });
    expect(readLocalPhotos(m, "E2")).toEqual({});
    const server = { [CHILD]: { src: webpOf(20), by: OWNER, at: 1 }, [ORG]: { src: webpOf(30), by: OWNER, at: 1 } };
    expect(mergePhotos(server, readLocalPhotos(m, "E1"))).toEqual({ [ADULT]: mine, [ORG]: server[ORG] });
  });
  it("survives junk in storage", () => {
    const m = new Mem();
    m.setItem("heirloom.tree.photos.v1", "{not json");
    expect(readLocalPhotos(m, "E1")).toEqual({});
    m.setItem("heirloom.tree.photos.v1", JSON.stringify({ E1: { a: { src: 3 }, b: null } }));
    expect(readLocalPhotos(m, "E1")).toEqual({ b: null });
  });
});
