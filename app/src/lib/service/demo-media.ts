/**
 * Chain mode without a photo server (no Supabase): Thabo's two demo assets on devnet still show their photos and
 * spec sheets. The photos are bundled with the app (app/public/demo/assets) and DEMO_ASSETS carries each asset's
 * media root, so when an asset's on-chain AssetMedia.photos_root equals one of those roots, the bundled set IS the
 * set the chain commits to (same hash). Never on mainnet: a real estate's photos only ever come from its owner.
 */
import type { Cluster } from "../chain/config";
import type { AssetKind, AssetMediaInfo } from "../guardians/types";
import { DEMO_ASSETS } from "./demo-asset-photos";

export interface OnChainMedia { asset: string; kind: AssetKind; photosRoot: string; updatedAt: number }

/** The bundled demo media for every on-chain record whose root matches a demo asset (skipping assets in `known`). */
export function bundledDemoMedia(onChain: OnChainMedia[], cluster: Cluster, known: ReadonlySet<string> = new Set()): AssetMediaInfo[] {
  if (cluster === "mainnet-beta") return [];
  const byRoot = new Map(Object.values(DEMO_ASSETS).map((d) => [d.mediaRoot, d]));
  return onChain.flatMap((m) => {
    const d = byRoot.get(m.photosRoot);
    if (!d || known.has(m.asset)) return [];
    return [{
      asset: m.asset, kind: m.kind, title: d.title, photos: structuredClone(d.photos), spec: structuredClone(d.spec),
      photosRoot: d.mediaRoot, updatedAt: m.updatedAt, onChainMatch: true,
    }];
  });
}
