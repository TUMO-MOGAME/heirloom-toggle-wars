"use client";
/**
 * Photos on the Trust Tree (plan.md §15.11): the round (or, for an organisation, rounded-square) avatar used by the
 * family list and the person card, and the card's "Add photo / Change photo / Remove photo" controls for whoever may
 * change it (lib/tree/photos.ts photoConsent). Initials when there is no photo. The image is decorative (alt=""),
 * because the name always sits beside it. A hidden person never shows one.
 */
import { useRef, useState } from "react";
import clsx from "clsx";
import { Pencil, Plus, Trash2 } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { initials } from "@/lib/tree/layout";
import type { TreePerson } from "@/lib/tree/types";
import { PhotoPrepFailure, prepareTreePhoto, type PhotoPrepError } from "@/lib/tree/photo-image";
import { fill, type Copy } from "./words";

type AvatarPerson = Pick<TreePerson, "hidden" | "org" | "photo"> & { alive: boolean };

/** The photo, or initials (a dot for a hidden person). Sizes and borders come from `className`. */
export function Avatar({ p, name, me, className }: { p: AvatarPerson; name: string; me?: boolean; className?: string }) {
  // A photo that fails to load (e.g. a bundled demo face offline) falls back to initials.
  const [broken, setBroken] = useState<string | null>(null);
  const src = !p.hidden && p.photo?.src !== broken ? p.photo?.src : undefined;
  return (
    <span
      className={clsx(
        "grid shrink-0 place-items-center overflow-hidden border-[1.5px] font-semibold",
        p.org ? "rounded-lg" : "rounded-full",
        p.alive ? "bg-surface-2 text-ink" : "bg-bg text-ink-2",
        me ? "border-amber" : p.alive ? "border-line-strong" : "border-ink-2",
        p.hidden && "border-dashed",
        className,
      )}
      aria-hidden="true"
    >
      {src
        // A 256 px data: URL made on the device, or a bundled demo face: next/image has nothing to optimise here.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={src} alt="" width={256} height={256} decoding="async" onError={() => setBroken(src)} className="size-full object-cover" />
        : p.hidden ? "·" : initials(name)}
    </span>
  );
}

/**
 * The card's photo block: the large avatar, the memorial label ("Added by Thabo, 2026") and, for whoever may change
 * it, the file picker. The picked photo is cropped, shrunk and re-encoded on this device before `onSave` sees it.
 */
export function PhotoPanel({
  p, name, me, copy, right, addedByName, busy, onSave,
}: {
  p: AvatarPerson; name: string; me: boolean; copy: Copy;
  /** Who may change it here ("own" / "owner"), or null. */
  right: "own" | "owner" | null;
  addedByName: string;
  busy: boolean;
  /** A prepared WebP data URL, or null to remove. Resolves true when saved. */
  onSave?: (src: string | null) => Promise<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<PhotoPrepError | null>(null);
  const photo = !p.hidden ? p.photo : undefined;
  const can = !!right && !!onSave;
  if (!photo && !can) return null;

  const pick = async (file: File | undefined) => {
    if (!file || !onSave) return;
    setError(null);
    setWorking(true);
    try {
      const src = await prepareTreePhoto(file);
      await onSave(src);
    } catch (e) {
      setError(e instanceof PhotoPrepFailure ? e.reason : "unreadable");
    } finally {
      setWorking(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        <Avatar p={p} name={name} me={me} className="size-24 text-h3" />
        <div className="grid min-w-0 flex-1 gap-2">
          {photo?.memorial && <p className="text-small text-ink-2">{fill(copy.photo.memorial, { name: addedByName, year: photo.year })}</p>}
          {can && (
            <div className="print-hide flex flex-wrap gap-2">
              <Button variant="secondary" small loading={working || busy} onClick={() => input.current?.click()}>
                {photo ? <Pencil className="size-4" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
                {photo ? copy.photo.change : copy.photo.add}
              </Button>
              {photo && (
                <Button variant="ghost" small disabled={working || busy} onClick={() => { setError(null); void onSave!(null); }}>
                  <Trash2 className="size-4" aria-hidden="true" />{copy.photo.remove}
                </Button>
              )}
              <input
                ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1}
                aria-label={fill(copy.photo.choose, { name })}
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </div>
          )}
        </div>
      </div>
      {working && <p className="text-small text-ink-2" role="status">{copy.photo.working}</p>}
      {error && <p className="text-small font-semibold text-ink" role="alert">{copy.photo.errors[error]}</p>}
      {can && <p className="print-hide text-small text-ink-2">{right === "own" ? copy.photo.ownNote : copy.photo.ownerNote}</p>}
    </div>
  );
}
