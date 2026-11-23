/** The handover pack: the sale's facts per asset (mock and chain), and who on the seller side may open it. */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { isSellerSide, isVehicle, recordedHash, saleOf } from "./handover";
import { createMockService, DEMO_PERSONAS } from "../service/mock";
import { saleFromEvent } from "../chain/events";
import { fromBase } from "../format";

type Svc = ReturnType<typeof createMockService>;
const P = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
const act = (svc: Svc, key: string) => { const p = P(key); svc.setActor({ address: p.address, role: p.role, label: p.label }); };

async function sold() {
  const svc = createMockService({ instant: true });
  svc.resetDemo("listed");
  act(svc, "nomsa");
  const [{ estate }] = await svc.listEstatesFor(P("nomsa").address);
  const before = await svc.getEstate(estate);
  const [car, bike] = before.assets;
  const { tx, ranking } = await svc.acceptBestOffer(estate, car.address);
  const best = before.offers.find((o) => o.address === ranking.bestOffer)!;
  return { svc, estate, car, bike, tx, best, snap: await svc.getEstate(estate) };
}

describe("saleOf (mock)", () => {
  it("records the buyer, price, date and transaction of the asset sold (stage listed, then settle)", async () => {
    const { snap, car, tx, best } = await sold();
    const s = saleOf(snap, car.address)!;
    expect(s).toMatchObject({ asset: car.address, buyer: best.buyer, recipient: snap.estate.address, hardship: false, txSignature: tx.signature, amount: best.amount });
    expect(s.buyerName).toBeTruthy();
    expect(s.ts).toBeGreaterThan(0);
  });

  it("is null for an asset that has not been sold", async () => {
    const { snap, bike } = await sold();
    expect(saleOf(snap, bike.address)).toBeNull();
    expect(saleOf(snap, "nope")).toBeNull();
  });

  it("matches the right sale when two assets are sold", async () => {
    const { svc, estate, car, bike, best } = await sold();
    await svc.listAsset(estate, bike.address, 3600);
    act(svc, "zanele");
    await svc.placeOffer(estate, bike.address, 1900);
    act(svc, "nomsa");
    const { tx } = await svc.acceptBestOffer(estate, bike.address);
    const snap = await svc.getEstate(estate);
    expect(saleOf(snap, bike.address)).toMatchObject({ txSignature: tx.signature });
    expect(fromBase(saleOf(snap, bike.address)!.amount!)).toBe(1900);
    expect(saleOf(snap, car.address)!.amount).toBe(best.amount);
  });

  it("a demo saved before sale records existed still finds its single sale (buyer unknown)", async () => {
    const { snap, car } = await sold();
    const old = { ...snap, activity: snap.activity.map(({ sale: _s, ...a }) => { void _s; return a; }) };
    expect(saleOf(old, car.address)).toMatchObject({ buyer: null, amount: snap.activity.find((a) => a.kind === "AssetSold")!.amount });
  });
});

describe("saleFromEvent (chain)", () => {
  it("reads asset, buyer and recipient from the AssetSold event", () => {
    const k = () => PublicKey.unique();
    const [asset, buyer, recipient] = [k(), k(), k()];
    expect(saleFromEvent("assetSold", { asset, buyer, recipient, amount: 1, hardship: true })).toEqual({ asset: asset.toBase58(), buyer: buyer.toBase58(), recipient: recipient.toBase58(), hardship: true });
    expect(saleFromEvent("ClaimPaid", { asset, buyer, recipient })).toBeNull();
    expect(saleFromEvent("AssetSold", { asset })).toBeNull();
  });
});

describe("who may open the pack", () => {
  it("the seller side: owner, trusted people and family; not buyers or monitors", async () => {
    const { snap } = await sold();
    for (const key of ["thabo", "nomsa", "david", "busi", "lerato", "sipho", "naledi"]) expect(isSellerSide(snap, P(key).address)).toBe(true);
    for (const key of ["zanele", "zodwa"]) expect(isSellerSide(snap, P(key).address)).toBe(false);
  });

  it("vehicles get the licensing-office steps; a recorded hash is never all zeros", () => {
    expect([isVehicle("Car"), isVehicle("Motorbike"), isVehicle("Jewellery")]).toEqual([true, true, false]);
    expect(recordedHash("0".repeat(64))).toBeNull();
    expect(recordedHash("ab".repeat(32))).toBe("ab".repeat(32));
  });
});
