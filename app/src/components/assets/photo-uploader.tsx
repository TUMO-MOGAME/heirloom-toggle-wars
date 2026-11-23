"use client";
/**
 * Pick or take up to 24 photos (JPEG, PNG, HEIC, AVIF, WebP), convert each to WebP on this device (visible progress),
 * then preview, label (Front, Engine, …), reorder, make one the cover (photo 1) and remove. The parent owns the list
 * (`items`) and uploads it; this component never sends anything.
 */
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import clsx from "clsx";
import { ArrowUpFromLine, ChevronLeft, ChevronRight, FileUp, Plus, Trash2 } from "@/components/ui/icons";
import type { AssetsCopy } from "@/content/assets";
import { fmt } from "@/components/shell/copy";
import type { PhotoItem } from "@/lib/media/client";
import { MAX_PHOTOS, preparePhoto, WebpError } from "@/lib/media/webp";
import { isPhotoLabel, PHOTO_LABELS, withLabel } from "@/lib/assets/spec";

export type DraftPhoto = PhotoItem & { key: string; preview: string };

export function draftFromStored(p: Extract<PhotoItem, { kind: "stored" }>["photo"]): DraftPhoto {
  return { kind: "stored", photo: p, key: p.sha256, preview: p.url, ...(p.label ? { label: p.label } : {}) };
}

export function PhotoUploader({ id, copy, labels, title, items, onChange, disabled = false }: {
  id: string; copy: AssetsCopy["photos"]; labels: AssetsCopy["labels"]; title: string; items: DraftPhoto[]; onChange: (items: DraftPhoto[]) => void; disabled?: boolean;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [announce, setAnnounce] = useState("");
  const created = useRef<Set<string>>(new Set());
  const latest = useRef(items);
  useEffect(() => { latest.current = items; }, [items]);
  // Revoke the previews this uploader made when it goes away.
  useEffect(() => {
    const urls = created.current;
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); };
  }, []);

  const room = MAX_PHOTOS - items.length;
  const name = title.trim() || copy.title;

  const add = async (list: FileList | null) => {
    if (!list?.length || room <= 0) return;
    const files = Array.from(list).slice(0, room);
    const errs: string[] = list.length > room ? [fmt(copy.tooMany, { max: MAX_PHOTOS })] : [];
    setErrors([]);
    setProgress({ done: 0, total: files.length });
    let next = latest.current;
    for (const [i, f] of files.entries()) {
      try {
        // WebP made here, or (browsers that cannot encode WebP) a photo our server converts: shown, not an error.
        const { kind, photo } = await preparePhoto(f);
        if (!next.some((x) => x.photo.sha256 === photo.sha256)) {
          const preview = URL.createObjectURL(photo.blob);
          created.current.add(preview);
          next = [...next, { kind, photo, key: `${photo.sha256}-${i}`, preview }];
          onChange(next);
        }
      } catch (e) {
        errs.push(fmt(copy.failed, { name: f.name || `#${i + 1}`, reason: e instanceof WebpError ? e.message : String(e) }));
      }
      setProgress({ done: i + 1, total: files.length });
    }
    setProgress(null);
    setErrors(errs);
    setAnnounce(fmt(copy.converted, { n: next.length }));
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
    setAnnounce(fmt(copy.moved, { n: to + 1 }));
    // Keep focus on the same control of the moved photo so keyboard users can keep moving it.
    requestAnimationFrame(() => document.getElementById(`${id}-${x.key}-${to > from ? "later" : "earlier"}`)?.focus());
  };

  const relabel = (i: number, value: string) => {
    onChange(items.map((x, j) => (j === i ? withLabel(x, isPhotoLabel(value) ? value : null) : x)));
  };

  const makeCover = (i: number) => {
    if (i <= 0) return;
    const next = [...items];
    const [x] = next.splice(i, 1);
    onChange([x, ...next]);
    setAnnounce(fmt(copy.coverSet, { n: i + 1 }));
    requestAnimationFrame(() => document.getElementById(`${id}-${x.key}-label`)?.focus());
  };

  const remove = (i: number) => {
    const x = items[i];
    if (x.kind === "new" && created.current.has(x.preview)) { URL.revokeObjectURL(x.preview); created.current.delete(x.preview); }
    onChange(items.filter((_, j) => j !== i));
    setAnnounce(fmt(copy.removed, { n: i + 1 }));
  };

  const busy = progress !== null;
  const pickClass = (on: boolean) => clsx(
    "flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border px-4 text-small font-medium focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]",
    on ? "border-ink bg-surface text-ink hover:bg-surface-2" : "cursor-not-allowed border-line-strong text-ink-2 opacity-60",
  );
  const canPick = !disabled && !busy && room > 0;

  return (
    <fieldset className="flex min-w-0 flex-col gap-3" aria-describedby={`${id}-hint`}>
      <legend className="text-small font-semibold">{copy.title}</legend>
      <p id={`${id}-hint`} className="text-small text-ink-2">{fmt(copy.body, { max: MAX_PHOTOS })}</p>

      {room > 0 ? (
        <div className="flex flex-wrap gap-2">
          <label htmlFor={`${id}-pick`} className={pickClass(canPick)}>
            <FileUp className="size-4" aria-hidden="true" />{items.length ? copy.pickMore : copy.pick}
            <input id={`${id}-pick`} type="file" accept="image/*" multiple disabled={!canPick} className="sr-only"
              onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          </label>
          {/* Opens the camera straight away on phones (capture); the other input lets people pick from their gallery. */}
          <label htmlFor={`${id}-camera`} className={pickClass(canPick)}>
            <Plus className="size-4" aria-hidden="true" />{copy.take}
            <input id={`${id}-camera`} type="file" accept="image/*" capture="environment" multiple disabled={!canPick} className="sr-only"
              onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      ) : <p className="text-small text-ink-2">{fmt(copy.full, { max: MAX_PHOTOS })}</p>}
      <p className="text-[0.75rem] text-ink-2">{fmt(copy.pickHint, { max: MAX_PHOTOS })}</p>

      {progress && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-progress`} className="text-small font-medium">{fmt(copy.converting, { done: Math.min(progress.done + 1, progress.total), total: progress.total })}</label>
          <progress id={`${id}-progress`} max={progress.total} value={progress.done} className="h-2 w-full accent-[var(--ink)]" />
        </div>
      )}
      {errors.length > 0 && (
        <ul role="alert" className="flex flex-col gap-1 border-l-4 border-ink pl-2 text-small font-semibold">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      {items.some((x) => x.kind === "raw") && <p className="text-small text-ink-2" role="note">{copy.serverConvert}</p>}
      {items.length === 0 ? <p className="text-small text-ink-2">{copy.empty}</p> : (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((it, i) => (
            <li key={it.key} className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line-strong bg-surface">
              <div className="relative aspect-[4/3] w-full bg-surface-2">
                <Image src={it.preview} alt={fmt(copy.previewAlt, { n: i + 1, title: name })} fill sizes="(min-width: 640px) 200px, 45vw" className="object-cover" unoptimized />
                <span className="absolute left-1.5 top-1.5 rounded-full bg-ink px-2 py-0.5 text-[0.7rem] font-semibold tabular-nums text-bg">
                  {i === 0 ? copy.cover : i + 1}
                </span>
                {it.kind === "raw" && (
                  <span className="absolute inset-x-1.5 bottom-1.5 rounded-sm bg-surface px-1.5 py-0.5 text-[0.7rem] font-semibold leading-tight text-ink">{copy.serverBadge}</span>
                )}
              </div>
              <div className="px-1.5 pt-1.5">
                <label htmlFor={`${id}-${it.key}-label`} className="sr-only">{fmt(copy.labelFor, { n: i + 1 })}</label>
                <select
                  id={`${id}-${it.key}-label`} value={it.label ?? ""} disabled={disabled || busy} onChange={(e) => relabel(i, e.target.value)}
                  className="min-h-11 w-full rounded-md border border-line-strong bg-surface px-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:opacity-60"
                >
                  <option value="">{copy.noLabel}</option>
                  {PHOTO_LABELS.map((l) => <option key={l} value={l}>{labels[l]}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between gap-0.5 p-1">
                <button type="button" id={`${id}-${it.key}-earlier`} disabled={disabled || busy || i === 0} onClick={() => move(i, i - 1)}
                  aria-label={fmt(copy.moveEarlier, { n: i + 1 })} className="grid size-11 place-items-center rounded-full hover:bg-surface-2 disabled:opacity-40">
                  <ChevronLeft className="size-5" aria-hidden="true" />
                </button>
                {i > 0 && (
                  <button type="button" disabled={disabled || busy} onClick={() => makeCover(i)}
                    aria-label={fmt(copy.makeCover, { n: i + 1 })} title={fmt(copy.makeCover, { n: i + 1 })} className="grid size-11 place-items-center rounded-full hover:bg-surface-2 disabled:opacity-40">
                    <ArrowUpFromLine className="size-5" aria-hidden="true" />
                  </button>
                )}
                <button type="button" disabled={disabled || busy} onClick={() => remove(i)}
                  aria-label={fmt(copy.remove, { n: i + 1 })} className="grid size-11 place-items-center rounded-full hover:bg-surface-2 disabled:opacity-40">
                  <Trash2 className="size-5" aria-hidden="true" />
                </button>
                <button type="button" id={`${id}-${it.key}-later`} disabled={disabled || busy || i === items.length - 1} onClick={() => move(i, i + 1)}
                  aria-label={fmt(copy.moveLater, { n: i + 1 })} className="grid size-11 place-items-center rounded-full hover:bg-surface-2 disabled:opacity-40">
                  <ChevronRight className="size-5" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    </fieldset>
  );
}
