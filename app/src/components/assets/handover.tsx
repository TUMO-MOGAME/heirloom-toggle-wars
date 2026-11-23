"use client";
/**
 * The handover pack (/car/handover?asset=<asset address>): after a sale, a printable one-page summary for the seller side
 * (executor, trusted people, family): the asset with its cover photo and spec sheet, the buyer's wallet, price,
 * date and transaction, and the next steps at the licensing office, marked as guidance, not legal advice.
 * Print styles live in globals.css (.print-sheet): the app's frame is hidden and the page prints in black on white.
 */
import { useSyncExternalStore } from "react";
import Image from "next/image";
import { ArrowLeft, CarFront, FileText, Info, Store } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import type { AssetsCopy } from "@/content/assets";
import { useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot } from "@/lib/service";
import type { Base58, WalletSession } from "@/lib/types";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { isSellerSide, isVehicle, recordedHash, saleOf } from "@/lib/assets/handover";
import { Button, ButtonLink, Card, DefList, EmptyState, Eyebrow, ExplorerLink, LoadingCards, Money, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate } from "@/components/shell/gate";
import { CopyValue } from "@/components/shell/proof-drawer";
import { kindOf, useAssetMedia } from "./media";
import { SpecSheet } from "./spec-sheet";

type Copy = ScreensCopy["handover"];
const longDate = (secs: number) => new Date(secs * 1000).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });

const noSubscribe = () => () => {};
/** The asset from `?asset=` (read in the browser; null while prerendering). */
function useAssetParam(): Base58 | null | undefined {
  return useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get("asset"), () => undefined);
}

export function HandoverScreen({ copy: english, assets }: { copy: Copy; assets: AssetsCopy }) {
  const copy = useLocalized(english, (t) => t.screens.handover);
  const asset = useAssetParam();
  if (asset === undefined) return <LoadingCards label={copy.metaTitle} />;
  return (
    <Gate roles={["owner", "beneficiary", "verifier"]}>
      {({ snap, session }) => <Pack copy={copy} a={assets} snap={snap!} session={session} asset={asset ?? ""} />}
    </Gate>
  );
}

/** On screen a short, copyable value; on paper the whole value, so it can be typed back in. */
function Full(props: { value: string; copyLabel: string; copiedLabel: string }) {
  return (
    <>
      <span className="print:hidden"><CopyValue {...props} /></span>
      <span className="hidden break-all font-mono text-[0.75rem] print:inline">{props.value}</span>
    </>
  );
}

function Pack({ copy, a, snap, session, asset }: { copy: Copy; a: AssetsCopy; snap: EstateSnapshot; session: WalletSession; asset: Base58 }) {
  const { common } = useCopy();
  const { service, fx, isMock } = useEstate();
  const { media: all } = useAssetMedia(service, snap);
  const now = useNow(60000);
  const car = snap.assets.find((x) => x.address === asset);
  const back = <ButtonLink href="/car" variant="secondary">{copy.back}</ButtonLink>;
  if (!car || !isSellerSide(snap, session.address)) {
    return <EmptyState level={1} icon={<CarFront className="size-6" aria-hidden="true" />} title={copy.notFound.title} body={copy.notFound.body} action={back} />;
  }
  const sale = saleOf(snap, asset);
  if (!sale) {
    return <EmptyState level={1} icon={<CarFront className="size-6" aria-hidden="true" />} title={copy.notSold.title} body={copy.notSold.body} action={back} />;
  }
  const media = all[asset];
  const kind = kindOf(media);
  const title = media?.title || car.title;
  const cover = media?.photos.find((p) => p.url && !p.url.startsWith("blob:")) ?? media?.photos[0];
  const rate = fx?.usdtZar ?? null;
  const estate = snap.estate;
  const recipient = sale.recipient === null || sale.recipient === estate.address ? copy.sale.vault
    : snap.beneficiaries.find((b) => b.wallet === sale.recipient)?.label ?? sale.recipient;
  const steps = isVehicle(kind) ? copy.steps.vehicle : copy.steps.other;
  const doc = recordedHash(car.docHash);

  return (
    <article aria-labelledby="handover-title" className="print-sheet mx-auto grid max-w-4xl gap-5 *:min-w-0">
      <div className="print-hide flex flex-wrap items-center justify-between gap-2">
        <ButtonLink href="/car" variant="ghost" small><ArrowLeft className="size-4" aria-hidden="true" />{copy.back}</ButtonLink>
        <Button onClick={() => window.print()}><FileText className="size-5" aria-hidden="true" />{copy.print}</Button>
      </div>

      <header className="min-w-0 border-b-2 border-ink pb-4">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1 id="handover-title" className="mt-1 text-h2">{title}</h1>
        <p className="mt-2 text-ink-2">{copy.body}</p>
        <p className="mt-1 min-h-5 text-small text-ink-2">{now !== null ? fmt(copy.printed, { date: longDate(now) }) : ""}</p>
      </header>

      {isMock && <Notice tone="warn" icon={<Info className="size-5" aria-hidden="true" />}>{copy.simulated}</Notice>}

      <div className="grid gap-5 *:min-w-0 md:grid-cols-[1fr_1.2fr] md:items-start print:grid-cols-[1fr_1.2fr]">
        <figure className="print-avoid overflow-hidden rounded-lg border border-line-strong">
          {cover?.url ? (
            <div className="relative aspect-[4/3] w-full bg-surface-2">
              <Image src={cover.url} alt={fmt(copy.asset.cover, { title })} fill sizes="(min-width: 768px) 400px, 100vw" className="object-cover" quality={80} unoptimized={!cover.url.startsWith("/demo/")} />
            </div>
          ) : (
            <div className="grid aspect-[4/3] w-full place-items-center bg-surface-2 text-small text-ink-2">
              <span className="flex flex-col items-center gap-2"><Store className="size-8" aria-hidden="true" />{copy.asset.noPhoto}</span>
            </div>
          )}
          <figcaption className="px-3 py-2 text-small text-ink-2">{a.kinds[kind]} · {common.status.asset[car.status]}</figcaption>
        </figure>

        <Card role="region" aria-labelledby="handover-sale" className="print-avoid">
          <h2 id="handover-sale" className="text-h3">{copy.sale.title}</h2>
          <DefList className="mt-3 sm:grid-cols-1" items={[
            { term: copy.sale.seller, value: fmt(copy.sale.sellerValue, { name: estate.ownerName }) },
            ...(sale.buyerName ? [{ term: copy.sale.buyer, value: sale.buyerName }] : []),
            { term: copy.sale.buyerWallet, value: sale.buyer ? <span className="break-all font-mono text-small">{sale.buyer}</span> : copy.sale.unknown },
            { term: copy.sale.price, value: sale.amount !== null ? <Money base={sale.amount} rate={rate} /> : copy.sale.unknown },
            { term: copy.sale.date, value: longDate(sale.ts) },
            { term: copy.sale.proceeds, value: recipient },
            {
              term: copy.sale.tx,
              value: sale.txSignature ? (
                <span className="flex flex-col">
                  <ExplorerLink signature={sale.txSignature} label={copy.sale.tx} srLabel={copy.sale.txSr} className="print-hide" />
                  <span className="hidden break-all font-mono text-[0.75rem] print:inline">{sale.txSignature}</span>
                </span>
              ) : copy.sale.unknown,
            },
          ]} />
          <p className="mt-3 text-small">{copy.sale.titleMoved}</p>
          {sale.hardship && <p className="mt-1 text-small">{copy.sale.hardship}</p>}
        </Card>
      </div>

      <Card role="region" aria-labelledby="handover-asset" className="print-avoid">
        <h2 id="handover-asset" className="text-h3">{copy.asset.title}</h2>
        <DefList className="mt-3" items={[
          { term: copy.asset.kind, value: a.kinds[kind] },
          { term: copy.asset.estate, value: <Full value={estate.address} copyLabel={common.proof.copy} copiedLabel={common.proof.copied} /> },
          ...(doc ? [{ term: copy.asset.doc, value: <Full value={doc} copyLabel={common.proof.copy} copiedLabel={common.proof.copied} /> }] : []),
        ]} />
      </Card>

      <SpecSheet spec={media?.spec} kind={kind} copy={a.spec} />

      <Card role="region" aria-labelledby="handover-steps" className="print-avoid border-2 border-ink">
        <h2 id="handover-steps" className="text-h3">{copy.steps.title}</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 marker:font-semibold">
          {steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <Notice tone="accent" icon={<Info className="size-5" aria-hidden="true" />} className="mt-4">{copy.steps.note}</Notice>
      </Card>
    </article>
  );
}
