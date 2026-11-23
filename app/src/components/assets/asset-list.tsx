"use client";
/** The estate's assets as a row of cards; choosing one shows its listing below. */
import Image from "next/image";
import clsx from "clsx";
import { CarFront, Plus, Store } from "@/components/ui/icons";
import { Badge, Button } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import type { AssetsCopy } from "@/content/assets";
import type { Asset } from "@/lib/types";
import { kindOf, type MediaMap } from "./media";
import { Marked } from "@/components/ui/marked";

export function AssetList({ copy, assets, media, current, onSelect, onAdd }: {
  copy: AssetsCopy; assets: Asset[]; media: MediaMap; current: string; onSelect: (address: string) => void; onAdd?: () => void;
}) {
  const { common } = useCopy();
  const l = copy.list;
  return (
    <section aria-labelledby="assets-list-title" className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-sans text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.eyebrow}</p>
          <h1 id="assets-list-title" className="text-h2"><Marked text={l.title} /></h1>
          <p className="mt-1 text-ink-2">{l.body}</p>
        </div>
        {onAdd && <Button variant="secondary" small onClick={onAdd}><Plus className="size-4" aria-hidden="true" />{l.add}</Button>}
      </div>
      <ul aria-label={l.navLabel} className="mt-3 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3">
        {assets.map((a) => {
          const m = media[a.address];
          const kind = kindOf(m);
          const cover = m?.photos[0];
          const count = m?.photos.length ?? 0;
          const on = a.address === current;
          return (
            <li key={a.address} className="min-w-0">
              <button
                type="button" onClick={() => onSelect(a.address)} aria-current={on ? "true" : undefined}
                className={clsx("flex w-full min-w-0 items-center gap-3 rounded-md border bg-surface p-2.5 text-left hover:bg-surface-2", on ? "border-2 border-ink" : "border-line-strong")}
              >
                <span className="relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2">
                  {cover ? <Image src={cover.url} alt="" fill sizes="64px" className="object-cover" unoptimized={!cover.url.startsWith("/demo/")} />
                    : kind === "Car" ? <CarFront className="size-6 text-ink-2" aria-hidden="true" /> : <Store className="size-6 text-ink-2" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{m?.title || a.title}</span>
                  <span className="block text-small text-ink-2">{copy.kinds[kind]} · {count === 0 ? l.noPhotos : count === 1 ? l.onePhoto : fmt(l.photos, { n: count })}</span>
                  <Badge tone={a.status === "Sold" ? "ok" : a.status === "Listed" ? "warn" : "neutral"} className="mt-1">{common.status.asset[a.status]}</Badge>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
