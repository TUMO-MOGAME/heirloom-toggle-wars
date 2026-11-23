"use client";
/** Owner, estate Active: change the photos of an asset that is already on the estate. */
import { useState, type FormEvent } from "react";
import { Button, Card, Consent } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import type { AssetsCopy } from "@/content/assets";
import { useEstate } from "@/lib/hooks/estate";
import type { Asset, Role, WalletSession } from "@/lib/types";
import type { AssetMediaView } from "@/lib/media/api";
import { draftFromStored, PhotoUploader, type DraftPhoto } from "./photo-uploader";
import { kindOf, savePhotos } from "./media";

export function PhotoEditor({ copy, asset, media, session, role, onClose }: {
  copy: AssetsCopy; asset: Asset; media?: AssetMediaView; session: WalletSession; role: Role; onClose: () => void;
}) {
  const { common } = useCopy();
  const { run, busy } = useEstate();
  const p = copy.photos;
  const title = media?.title || asset.title;
  const [items, setItems] = useState<DraftPhoto[]>(() => (media?.photos ?? []).map(draftFromStored));
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await run("photos", (service, estate) => savePhotos({
      service, estate, session, role, asset: asset.address, kind: kindOf(media), title, description: media?.description ?? "",
      items, spec: media?.spec, onProgress: (done, total) => setProgress({ done, total }),
    }), p.saved, true);
    setProgress(null);
    if (res.ok) onClose();
    else setError(res.message);
  };

  return (
    <Card>
      <h2 className="text-h3">{fmt(p.manageTitle, { title })}</h2>
      <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-4">
        <PhotoUploader id="edit-photos" copy={p} labels={copy.labels} title={title} items={items} onChange={setItems} disabled={busy === "photos"} />
        <p className="text-small text-ink-2">{p.onchainNote}</p>
        <Consent id="edit-photos-consent" checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
        {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
        <p className="sr-only" role="status" aria-live="polite">{progress ? fmt(copy.add.uploading, progress) : ""}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy === "photos"}>{busy === "photos" ? (progress ? fmt(copy.add.uploading, progress) : p.saving) : p.save}</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy === "photos"}>{copy.add.cancel}</Button>
        </div>
      </form>
    </Card>
  );
}
