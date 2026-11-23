"use client";
/**
 * Asset photos in the app: reading every asset's media for the current estate, and saving a photo set
 * (upload to /api/assets/photos when a photo server is available, else kept in this tab for the demo), then
 * recording the set's root on-chain with `setAssetMedia`.
 */
import { useEffect, useState } from "react";
import type { EstateSnapshot, HeirloomService } from "@/lib/service";
import type { Role, WalletSession } from "@/lib/types";
import type { AssetKind } from "@/lib/guardians/types";
import type { AssetSpec } from "@/lib/assets/spec";
import type { AssetMediaView } from "@/lib/media/api";
import { localPhotos, photosApi, type MediaSigner, type PhotoItem } from "@/lib/media/client";
import { peekActiveSigner } from "@/lib/wallet/signer";

export type MediaMap = Record<string, AssetMediaView>;

/** Older assets have no media record: they are all cars (the prototype only held a car). */
export const kindOf = (media?: AssetMediaView): AssetKind => media?.kind ?? "Car";

/** Every asset's photos for this estate; re-read whenever the snapshot changes (after any write). */
export function useAssetMedia(service: HeirloomService | null, snap: EstateSnapshot): { media: MediaMap; ready: boolean } {
  const [state, setState] = useState<{ key: string; media: MediaMap } | null>(null);
  const key = `${snap.estate.address}|${snap.assets.map((a) => a.address).join(",")}|${snap.activity.length}`;
  useEffect(() => {
    if (!service) return;
    let alive = true;
    service.getAssetMedia(snap.estate.address)
      .then((list) => { if (alive) setState({ key, media: Object.fromEntries(list.map((m) => [m.asset, m as AssetMediaView])) }); })
      .catch(() => { if (alive) setState({ key, media: {} }); });
    return () => { alive = false; };
    // `key` captures what matters in the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, key]);
  return { media: state?.media ?? {}, ready: state?.key === key };
}

let remote: Promise<boolean> | null = null;
/** Is there a photo server (chain mode, or a demo deployment with demo writes)? Asked once per page load. */
export function hasPhotoServer(): Promise<boolean> {
  remote ??= photosApi.probe().catch(() => false);
  return remote;
}

function signer(service: HeirloomService, estate: string, session: WalletSession, role: Role): MediaSigner {
  if (service.mode === "chain") {
    const s = peekActiveSigner();
    if (!s) throw new Error("No wallet is active. Create or choose a wallet first.");
    return { estate, wallet: s.address, sign: (m) => s.signMessage(m) };
  }
  return { estate, wallet: session.address, sign: async () => "demo", demoRole: role === "owner" ? "owner" : "child", demoLabel: session.label };
}

/**
 * Uploads (or keeps locally) the ordered photo set for one asset and records it with setAssetMedia.
 * Returns whether the photos stayed on this device (demo without a photo server).
 */
export async function savePhotos(args: {
  service: HeirloomService; estate: string; session: WalletSession; role: Role;
  asset: string; kind: AssetKind; title: string; description: string; items: PhotoItem[]; spec?: AssetSpec;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ local: boolean; info: AssetMediaView }> {
  const { service, estate, asset, kind, title, description, items, spec } = args;
  const local = !(await hasPhotoServer());
  const info = local
    ? await localPhotos({ asset, kind, title, description, items, spec })
    : await photosApi.save(signer(service, estate, args.session, args.role), { asset, kind, title, description, items, spec }, args.onProgress);
  // Description, labels and spec sheet are off-chain; the labels and spec sheet are part of the on-chain root.
  const input = { kind, title, photos: info.photos, description, spec: info.spec ?? spec };
  await service.setAssetMedia(estate, asset, input);
  return { local, info };
}
