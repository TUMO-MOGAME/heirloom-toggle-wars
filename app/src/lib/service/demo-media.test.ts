/**
 * Devnet without a photo server: the bundled demo photos + spec sheets stand in for an asset only when its on-chain
 * media root is exactly a demo root, never on mainnet. Also the devnet demo estate's off-chain defaults.
 */
import { describe, expect, it, vi } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getCoder, getIdl } from "../chain/idl";
import { cleanSpec, mediaRootHex } from "../assets/spec";
import { DEMO_ASSETS } from "./demo-asset-photos";
import { bundledDemoMedia } from "./demo-media";
import { DEVNET_DEMO_CHILDREN, DEVNET_DEMO_ESTATE, DEVNET_DEMO_GUARDIANS, DEVNET_DEMO_META } from "../chain/demo-estate";
import { SEAT_MONITOR_OFFSETS } from "../chain/guardians";
import type { Raw } from "../chain/decoders";

const programId = new PublicKey(getIdl().address);
const k = () => Keypair.generate().publicKey;
const mediaRaw = async (root: string) => getCoder().accounts.decode("AssetMedia", await getCoder().accounts.encode("AssetMedia", {
  asset: k(), kind: { Car: {} }, photos_root: Array.from(Buffer.from(root, "hex")), photo_count: 16, updated_at: new BN(1_700_000_000), bump: 1,
})) as Raw;

const corollaAsset = k().toBase58(), bikeAsset = k().toBase58(), otherAsset = k().toBase58(), uploadedAsset = k().toBase58();
const fixtures = {
  [corollaAsset]: await mediaRaw(DEMO_ASSETS.corolla.mediaRoot),
  [bikeAsset]: await mediaRaw(DEMO_ASSETS.mustang.mediaRoot),
  [otherAsset]: await mediaRaw("ab".repeat(32)),
  [uploadedAsset]: await mediaRaw(DEMO_ASSETS.corolla.mediaRoot),
};
const uploaded = { asset: uploadedAsset, kind: "Car" as const, title: "From the photo server", photos: [], photosRoot: "00".repeat(32), updatedAt: 1 };

vi.mock("../chain/client", () => ({ chainCtx: () => ({ programId, usdtMint: PublicKey.default }) }));
vi.mock("../media/client", () => ({ photosApi: { list: vi.fn(async () => [uploaded]) } }));
vi.mock("../chain/guardians", async (orig) => ({
  ...(await orig<typeof import("../chain/guardians")>()),
  fetchGuardiansRaw: async () => ({ guard: null, seats: [], objections: [], stamps: {}, media: fixtures }),
}));

describe("bundled demo media", () => {
  it("each demo asset's media root commits to its bundled photos, labels and spec sheet", async () => {
    for (const d of Object.values(DEMO_ASSETS)) expect(await mediaRootHex(d.photos, cleanSpec(d.spec))).toBe(d.mediaRoot);
  });

  it("matches an on-chain root to the demo asset on devnet", () => {
    const [m] = bundledDemoMedia([{ asset: "A", kind: "Motorbike", photosRoot: DEMO_ASSETS.mustang.mediaRoot, updatedAt: 5 }], "devnet");
    expect(m).toMatchObject({ asset: "A", kind: "Motorbike", title: DEMO_ASSETS.mustang.title, photosRoot: DEMO_ASSETS.mustang.mediaRoot, updatedAt: 5, onChainMatch: true });
    expect(m.photos).toHaveLength(DEMO_ASSETS.mustang.photos.length);
    expect(m.spec).toEqual(DEMO_ASSETS.mustang.spec);
    expect(m.photos).not.toBe(DEMO_ASSETS.mustang.photos); // a copy: the UI may not change the bundled set
  });

  it("never on mainnet, never for another root, never over an asset already known", () => {
    const corolla = { asset: "A", kind: "Car" as const, photosRoot: DEMO_ASSETS.corolla.mediaRoot, updatedAt: 1 };
    expect(bundledDemoMedia([corolla], "mainnet-beta")).toEqual([]);
    expect(bundledDemoMedia([{ ...corolla, photosRoot: "ab".repeat(32) }], "devnet")).toEqual([]);
    expect(bundledDemoMedia([corolla], "devnet", new Set(["A"]))).toEqual([]);
    expect(bundledDemoMedia([corolla], "localnet")).toHaveLength(1);
  });

  it("chain getAssetMedia adds the bundled set for demo roots and keeps the photo server's records", async () => {
    const { createChainGuardians } = await import("./chain-guardians");
    const svc = createChainGuardians({
      send: async () => { throw new Error("not used"); }, review: async () => { throw new Error("not used"); },
      getMeta: async () => null, saveMeta: async () => undefined, requireOwnerOf: () => PublicKey.default, getEstate: async () => ({}),
    });
    const list = await svc.getAssetMedia(k().toBase58());
    const by = Object.fromEntries(list.map((m) => [m.asset, m]));
    expect(Object.keys(by).sort()).toEqual([corollaAsset, bikeAsset, uploadedAsset].sort());
    expect(by[corollaAsset]).toMatchObject({ title: DEMO_ASSETS.corolla.title, onChainMatch: true });
    expect(by[corollaAsset].photos).toHaveLength(DEMO_ASSETS.corolla.photos.length);
    expect(by[bikeAsset].title).toBe(DEMO_ASSETS.mustang.title);
    expect(by[uploadedAsset]).toMatchObject({ title: "From the photo server", onChainMatch: false }); // its own photos win
  });
});

describe("devnet demo estate defaults", () => {
  it("names the guardians and children, and gives the fallback plan's kinds", async () => {
    const { guardianExtras } = await import("./chain-guardians");
    const x = guardianExtras(DEVNET_DEMO_META, {});
    expect(x.names[DEVNET_DEMO_GUARDIANS.zodwa]).toBe("Aunt Zodwa Mokoena");
    expect(x.names[DEVNET_DEMO_GUARDIANS.kagiso]).toBe("Cousin Kagiso Mokoena");
    expect(x.names[DEVNET_DEMO_GUARDIANS.priya]).toBe("Adv. Priya Naidoo");
    expect(x.fallbackKinds[DEVNET_DEMO_CHILDREN.lerato]).toBe("family");
    expect(x.fallbackKinds[DEVNET_DEMO_GUARDIANS.charity]).toBe("charity");
    expect(guardianExtras({ ...DEVNET_DEMO_META, estate: k().toBase58() }, {}).fallbackKinds).toEqual({});
    expect(DEVNET_DEMO_META.estate).toBe(DEVNET_DEMO_ESTATE);
    expect(Object.values(DEVNET_DEMO_META.assetTitles).sort()).toEqual([DEMO_ASSETS.corolla.title, DEMO_ASSETS.mustang.title].sort());
  });

  it("SEAT_MONITOR_OFFSETS point at Seat.monitors[0] and [1] (monitors find their estates)", async () => {
    const m0 = k(), m1 = k();
    const data = await getCoder().accounts.encode("Seat", {
      estate: k(), index: 2, holder: k(), backups: [k(), k()], monitors: [m0, m1], generation: 0, vacant: false,
      death_cert_hash: Array(32).fill(0), death_reported_by: PublicKey.default, death_verdict: { Pending: {} },
      death_confirmed_by: PublicKey.default, death_pending_since: new BN(0), bump: 1,
    });
    expect(new PublicKey(data.subarray(SEAT_MONITOR_OFFSETS[0], SEAT_MONITOR_OFFSETS[0] + 32)).equals(m0)).toBe(true);
    expect(new PublicKey(data.subarray(SEAT_MONITOR_OFFSETS[1], SEAT_MONITOR_OFFSETS[1] + 32)).equals(m1)).toBe(true);
  });
});
