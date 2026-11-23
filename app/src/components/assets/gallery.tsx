"use client";
/**
 * Photo gallery for an asset, for buyers and family. Opens on the cover (photo 1). One photo at a time with
 * previous/next buttons, thumbnails, arrow keys (Left/Right/Home/End) and swipe. When the photos are labelled,
 * filter buttons ("All (16)", "Engine (1)", …) show one group at a time, in label order. Alt text = asset title,
 * label and photo number. Swapping photos is instant (no slide animation), so there is nothing to reduce for
 * reduced-motion users.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import Image from "next/image";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "@/components/ui/icons";
import type { AssetsCopy } from "@/content/assets";
import { fmt } from "@/components/shell/copy";
import type { AssetPhoto } from "@/lib/guardians/types";
import { groupByLabel, type PhotoLabel } from "@/lib/assets/spec";

export function Gallery({ id, photos: all, title, copy, labels, badge }: {
  id: string; photos: AssetPhoto[]; title: string; copy: AssetsCopy["gallery"]; labels: AssetsCopy["labels"]; badge?: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [group, setGroup] = useState<PhotoLabel | null>(null);
  // Photos whose URL no longer loads (an expired link, or a demo photo from an earlier visit) are skipped.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const working = all.map((p, k) => ({ p, k })).filter(({ p }) => !broken.has(p.sha256));
  const groups = all.some((p) => p.label) ? groupByLabel(working.map(({ p }) => p)) : [];
  const shown = group ? working.filter(({ p }) => (p.label ?? "Other") === group) : working;
  const photos = shown.map(({ p }) => p);
  const number = (j: number) => shown[j].k + 1; // position in the whole set, so alt text stays stable across filters
  const pick = (g: PhotoLabel | null) => { setGroup(g); setIndex(0); };
  const start = useRef<{ x: number; y: number } | null>(null);
  const n = photos.length;
  const i = Math.min(index, Math.max(0, n - 1));
  const go = (to: number) => setIndex(((to % n) + n) % n);

  if (n === 0) return null;
  const photo = photos[i];
  const altOf = (p: AssetPhoto, j: number) => p.label
    ? fmt(copy.altLabelled, { title, label: labels[p.label], n: number(j) })
    : fmt(copy.alt, { title, n: number(j) });

  const onKey = (e: KeyboardEvent) => {
    const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to === null) return;
    e.preventDefault();
    go(to);
  };
  const onDown = (e: PointerEvent) => { if (e.pointerType !== "mouse") start.current = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? i + 1 : i - 1);
  };

  const navBtn = "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-ink bg-surface text-ink shadow-sm hover:bg-surface-2";

  return (
    <section aria-roledescription={copy.roledescription} aria-label={fmt(copy.label, { title })} className="flex min-w-0 flex-col">
      <div
        className="relative aspect-[4/3] w-full touch-pan-y select-none bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        tabIndex={n > 1 ? 0 : undefined} onKeyDown={n > 1 ? onKey : undefined}
        onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { start.current = null; }}
        aria-describedby={n > 1 ? `${id}-hint` : undefined}
      >
        <div role="group" aria-roledescription="slide" aria-label={fmt(copy.slide, { n: i + 1, total: n })} className="absolute inset-0">
          <Image
            key={photo.sha256} src={photo.url} alt={altOf(photo, i)} fill draggable={false}
            // Bundled demo photos are resized for the screen (quality 80); uploaded photos are shown as stored.
            sizes="(min-width: 1024px) 560px, 100vw" className="object-contain" quality={80} unoptimized={!photo.url.startsWith("/demo/")} priority={i === 0}
            onError={() => setBroken((b) => new Set(b).add(photo.sha256))}
          />
        </div>
        {badge && <span className="absolute left-3 top-3">{badge}</span>}
        {photo.label && (
          <span className="absolute bottom-2 left-2 rounded-full bg-ink px-2.5 py-0.5 text-[0.75rem] font-semibold text-bg" aria-hidden="true">{labels[photo.label]}</span>
        )}
        {n > 1 && (
          <>
            <button type="button" onClick={() => go(i - 1)} aria-label={copy.previous} className={clsx(navBtn, "left-2")}><ChevronLeft className="size-5" aria-hidden="true" /></button>
            <button type="button" onClick={() => go(i + 1)} aria-label={copy.next} className={clsx(navBtn, "right-2")}><ChevronRight className="size-5" aria-hidden="true" /></button>
            {/* Top right: on phones the floating "Ask Heirloom" button sits over the photo's bottom right corner. */}
            <span className="absolute right-3 top-3 rounded-full bg-ink px-2.5 py-0.5 text-[0.75rem] font-semibold tabular-nums text-bg" aria-hidden="true">{i + 1} / {n}</span>
          </>
        )}
      </div>
      {groups.length > 1 && (
        <div role="group" aria-label={copy.groups} className="flex flex-wrap gap-1.5 px-2 pt-2">
          {[{ key: null, text: fmt(copy.all, { n: working.length }) }, ...groups.map((g) => ({ key: g.label, text: fmt(copy.group, { label: labels[g.label], n: g.items.length }) }))].map((g) => (
            <button
              key={g.key ?? "all"} type="button" aria-pressed={group === g.key} onClick={() => pick(g.key)}
              className={clsx("min-h-11 rounded-full border px-3 text-small font-medium tabular-nums", group === g.key ? "border-ink bg-ink text-bg" : "border-line-strong bg-surface text-ink hover:bg-surface-2")}
            >
              {g.text}
            </button>
          ))}
        </div>
      )}
      {n > 1 && (
        <>
          <p id={`${id}-hint`} className="sr-only">{copy.hint}</p>
          <ul aria-label={copy.thumbs} className="flex gap-2 overflow-x-auto p-2">
            {photos.map((p, j) => (
              <li key={p.sha256} className="shrink-0">
                <button
                  type="button" onClick={() => go(j)} aria-label={p.label ? `${fmt(copy.show, { n: number(j) })}: ${labels[p.label]}` : fmt(copy.show, { n: number(j) })} aria-current={j === i ? "true" : undefined}
                  className={clsx("relative block size-14 overflow-hidden rounded-md border-2 bg-surface-2", j === i ? "border-ink" : "border-transparent opacity-75 hover:opacity-100")}
                >
                  {/* Bundled demo photos get resized thumbnails (each original is ~120 KB for a 56 px tile); uploads stay as they are. */}
                  <Image src={p.url} alt="" fill sizes="56px" className="object-cover" unoptimized={!p.url.startsWith("/demo/")} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="sr-only" aria-live="polite">{n > 1 ? fmt(copy.slide, { n: i + 1, total: n }) : ""}</p>
    </section>
  );
}
