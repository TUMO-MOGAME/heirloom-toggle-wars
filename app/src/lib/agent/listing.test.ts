import { describe, expect, it } from "vitest";
import type { Asset } from "../types";
import { mayAskToList } from "./sale";

const NOW = 10_000;
const NOBODY = [null, null, null];
const family = [{ wallet: "kid", active: true }, { wallet: "gone", active: false }];
const car = (over: Partial<Asset> = {}) => ({
  address: "car", status: "Listed" as Asset["status"], listingEnds: NOW - 1, floorPrice: 900n, hardshipFloor: 700n,
  hardshipBeneficiary: null, ...over,
});
const may = (asset: ReturnType<typeof car>, amounts: bigint[] = [], wallet = "kid", seats: (string | null)[] = NOBODY) =>
  mayAskToList(seats, family, wallet, asset, amounts.map((amount) => ({ asset: "car", amount })), NOW);

describe("listing with no trusted person left", () => {
  it("family lists a held asset", () => expect(may(car({ status: "Held", listingEnds: null }))).toBe(true));
  it("family relists once a listing ended with no offer", () => expect(may(car())).toBe(true));
  it("family relists when every offer is below the floor", () => expect(may(car(), [899n])).toBe(true));
  it("not over an acceptable offer: that would put off the sale", () => expect(may(car(), [900n])).toBe(false));
  it("an approved hardship lowers what is acceptable", () => expect(may(car({ hardshipBeneficiary: "kid" }), [700n])).toBe(false));
  it("not while the listing runs", () => expect(may(car({ listingEnds: NOW + 1 }))).toBe(false));
  it("not once sold", () => expect(may(car({ status: "Sold" }))).toBe(false));
  it("not someone removed from the plan", () => expect(may(car(), [], "gone")).toBe(false));
  it("not family while a seat is held", () => expect(may(car(), [], "kid", ["uncle", null, null])).toBe(false));
  it("an offer on another asset doesn't count", () =>
    expect(mayAskToList(NOBODY, family, "kid", car(), [{ asset: "bike", amount: 5_000n }], NOW)).toBe(true));
});
