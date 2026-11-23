"use client";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import Image from "next/image";
import clsx from "clsx";
import { ArrowRight, CarFront, FileText, Gavel, HandHeart, Loader2, Lock, Pencil, ShieldCheck, Store } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import type { AssetsCopy } from "@/content/assets";
import { useLocale, useLocalized } from "@/lib/i18n/client";
import { clockTime, nextReadyAt, offerWait } from "@/lib/assets/sale-wait";
import type { EstateSnapshot } from "@/lib/service";
import type { Asset, OfferRanking, Role, WalletSession } from "@/lib/types";
import { formatUsdt, formatUsdtExact, formatZar, fromBase, shortAddress, toBase } from "@/lib/format";
import { amountHint, amountText, parseAmount } from "@/lib/amount";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Badge, Button, ButtonLink, Card, Consent, EmptyState, Eyebrow, ExplorerLink, Field, inputClass, Money, Notice, TickDisc } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { Gate } from "@/components/shell/gate";
import { ActivityText, useNameBook } from "@/components/shell/activity-text";
import { usePay } from "@/components/pay/payment";
import { AddAsset, PhotoEditor, SpecEditor } from "@/components/assets/lazy";
import { AssetList } from "@/components/assets/asset-list";
import { Gallery } from "@/components/assets/gallery";
import { kindOf, useAssetMedia } from "@/components/assets/media";
import { SpecSheet } from "@/components/assets/spec-sheet";
import { hasSpec } from "@/lib/assets/spec";
import { isSellerSide, saleOf } from "@/lib/assets/handover";
import type { AssetMediaView } from "@/lib/media/api";
import { clock } from "@/components/guardians/derive";
import { PausedNotice } from "@/components/guardians/parts";
import { listingLink } from "@/lib/hooks/pick-estate";
import { fullName } from "@/lib/names";
import { ReferredNote, RelistNote } from "@/components/continuity/continuity";
import { listingEnded } from "@/lib/continuity/logic";
import { hardshipTally, hasLivingSeat, isFamily, isHeld, mayList } from "@/lib/guardians/decisions";
import { VoteTally } from "@/components/guardians/decision";
import { CoSign } from "@/components/continuity/cosign";
import { ReleaseAsset } from "@/components/continuity/membership";

type Copy = ScreensCopy["car"];
const num = (s: string) => parseAmount(s) ?? Number.NaN;

/**
 * Assets (route /car, kept so the demo guide and links still work): the estate's assets, "Add an asset" for the
 * owner, and the chosen asset's listing with its photo gallery, offers and the price floor. With a single asset
 * (the family car) it looks as it always did, with the photos added above the listing.
 */
export function CarScreen({ copy: english, assets: assetsEn }: { copy: Copy; assets: AssetsCopy }) {
  const copy = useLocalized(english, (t) => t.screens.car);
  const assets = useLocalized(assetsEn, (t) => t.assets);
  return (
    <Gate>
      {({ snap, session, role }) => <Assets copy={copy} a={assets} snap={snap!} session={session} role={role} />}
    </Gate>
  );
}

function Assets({ copy, a, snap, session, role }: { copy: Copy; a: AssetsCopy; snap: EstateSnapshot; session: WalletSession; role: Role }) {
  const { service } = useEstate();
  const { media } = useAssetMedia(service, snap);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Photos, the spec sheet and taking it back: the living owner only (R15, R22).
  const canEdit = role === "owner" && session.address === snap.estate.owner && snap.estate.status === "Active";
  const list = snap.assets;

  if (list.length === 0 || adding) {
    if (!canEdit) return <EmptyState icon={<CarFront className="size-6" aria-hidden="true" />} title={copy.emptyTitle} body={copy.emptyBody} />;
    return (
      <AddAsset car={copy} copy={a} snap={snap} session={session} role={role}
        onCancel={list.length ? () => setAdding(false) : undefined}
        onAdded={(addr) => { setAdding(false); setSelected(addr); window.scrollTo({ top: 0 }); }} />
    );
  }
  const current = list.find((x) => x.address === selected) ?? list[0];
  const showList = list.length > 1 || canEdit;
  return (
    <>
      {showList && <AssetList copy={a} assets={list} media={media} current={current.address} onSelect={setSelected} onAdd={canEdit ? () => setAdding(true) : undefined} />}
      <Listing key={current.address} copy={copy} a={a} snap={snap} car={current} media={media[current.address]} session={session} role={role} canEdit={canEdit} headingLevel={showList ? 2 : 1} />
    </>
  );
}

/* ---------- Listing, offers, the floor rule and the sale ---------- */

function Listing({ copy, a, snap, car, media, session, role, canEdit, headingLevel }: {
  copy: Copy; a: AssetsCopy; snap: EstateSnapshot; car: Asset; media?: AssetMediaView; session: WalletSession; role: Role; canEdit: boolean; headingLevel: 1 | 2;
}) {
  const { common, guardians } = useCopy();
  const { service, fx, run, busy } = useEstate();
  const book = useNameBook(snap);
  // A buyer's name: the one the offer carries, else whatever this estate or device knows about that wallet.
  const buyerName = (o: { buyer: string; buyerName?: string }) => o.buyerName ?? book.get(o.buyer)?.name;
  const now = useNow();
  const locale = useLocale();
  const rate = fx?.usdtZar ?? null;
  const e = snap.estate;
  const offers = snap.offers.filter((o) => o.asset === car.address).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const mine = offers.find((o) => o.buyer === session.address);
  // The approved one stands; otherwise one that is waiting.
  const requests = snap.hardships.filter((h) => h.asset === car.address);
  const hardship = requests.find((h) => h.status === "Approved" && car.hardshipBeneficiary === h.beneficiary) ?? requests.find((h) => h.status === "Open");
  const hardshipName = car.hardshipBeneficiary ? (snap.beneficiaries.find((b) => b.wallet === car.hardshipBeneficiary)?.label.split(" ")[0] ?? "") : "";
  // The sale line for this asset (an estate can sell more than one); see lib/assets/handover.ts.
  const saleFacts = saleOf(snap, car.address);
  const sale = saleFacts ? snap.activity.find((x) => x.kind === "AssetSold" && x.txSignature === saleFacts.txSignature && x.ts === saleFacts.ts) : undefined;
  const sellerSide = isSellerSide(snap, session.address);
  const family = isFamily(snap, session.address);
  const isVerifier = isHeld(session.address) && e.verifiers.includes(session.address);
  const staffed = hasLivingSeat(e);
  const relist = car.status === "Listed";
  const canList = e.status === "Unlocked" && now !== null && mayList(snap, car, session.address, now) && (!relist || listingEnded(car, now));
  const [editing, setEditing] = useState<"photos" | "spec" | null>(null);
  const kind = kindOf(media);
  const title = media?.title || car.title;
  const photos = media?.photos ?? [];
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const statusBadge = <Badge tone={car.status === "Sold" ? "ok" : car.status === "Listed" ? "warn" : "neutral"} >{common.status.asset[car.status]}</Badge>;
  const [ranking, setRanking] = useState<OfferRanking | null>(null);
  const offersKey = offers.map((o) => `${o.address}:${o.amount}`).join("|") + (car.hardshipBeneficiary ?? "");

  // When the offers change, clear the last block and (if none are left) the ranking: adjusted during render, not in an effect.
  const [seenOffers, setSeenOffers] = useState(offersKey);
  if (seenOffers !== offersKey) {
    setSeenOffers(offersKey);
    setRanking(null);
  }

  // What the program checks against the clock (lib/assets/sale-wait.ts): an offer, or the hardship approval, waits out
  // the objection window; one from before an upheld objection to the sale is never accepted. When the next window
  // closes, or the objections or offer times change (the demo can end a window), the ranking is read again.
  const g = snap.guardians;
  const waitCtx = { asset: car, objections: g?.objections, windowSecs: g?.enabled ? g.objectionWindowSecs : null };
  const due = nextReadyAt(ranking);
  const windowClosed = due !== null && now !== null && now >= due;
  const timingKey = offers.map((o) => o.createdAt).join("|") + (g?.objections ?? []).filter((o) => o.target === car.address || o.kind === "Hardship").map((o) => `${o.address}:${o.status}`).join("|");
  const waitOf = (o: { address: string; createdAt: number }) => (car.status === "Listed" ? offerWait(ranking, o, waitCtx) : null);
  const timeAt = (at: number) => (now === null ? "" : clockTime(at, now, locale));

  useEffect(() => {
    let alive = true;
    if (!service || offers.length === 0) return;
    service.rankOffers(car.address).then((r) => { if (alive) setRanking(r); }).catch(() => { if (alive) setRanking(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, offersKey, car.address, windowClosed, timingKey]);

  const statusOf = (o: { address: string; amount: bigint; createdAt: number }) => {
    const { address: addr, amount } = o;
    if (car.status === "Sold") return { tone: "neutral" as const, text: copy.offers.notChosen };
    if (ranking?.bestOffer === addr) return { tone: "ok" as const, text: copy.offers.leading };
    const el = ranking?.eligible.find((x) => x.offer === addr);
    if (el) return { tone: "accent" as const, text: copy.offers.canWin };
    const wait = waitOf(o);
    if (wait?.kind === "window") return { tone: "warn" as const, text: fmt(guardians.rules.sale.readyFrom, { time: timeAt(wait.readyAt) }) };
    if (wait?.kind === "tooOld") return { tone: "danger" as const, text: guardians.rules.sale.tooOldBadge };
    if (amount < car.hardshipFloor) return { tone: "danger" as const, text: copy.offers.blockedHard };
    if (amount < (car.hardshipBeneficiary ? car.hardshipFloor : car.floorPrice)) return { tone: "danger" as const, text: copy.offers.blocked };
    return { tone: "accent" as const, text: copy.offers.canWin };
  };
  const reasonOf = (o: { address: string; createdAt: number }) => {
    if (car.status === "Sold") return undefined;
    const wait = waitOf(o);
    const sale = guardians.rules.sale;
    if (wait?.kind === "window") {
      const left = now === null ? "" : `${fmt(sale.left, { time: clock(Math.max(0, wait.readyAt - now)) })} · `;
      return `${left}${wait.why === "hardship" ? sale.whyHardship : sale.whyOffer}`;
    }
    if (wait?.kind === "tooOld") return guardians.rules.errors.OfferTooOld;
    return ranking?.eligible.find((x) => x.offer === o.address)?.reason ?? ranking?.ineligible.find((x) => x.offer === o.address)?.reason;
  };
  const remaining = car.status === "Listed" && car.listingEnds && now !== null ? car.listingEnds - now : null;

  return (
    <div className="grid gap-5 *:min-w-0 lg:grid-cols-[1.1fr_1fr] lg:items-start">
      <div className="grid gap-5 *:min-w-0">
        <Card className="overflow-hidden p-0! sm:p-0!">
          {photos.length > 0 ? (
            <Gallery id={`gallery-${car.address}`} photos={photos} title={title} copy={a.gallery} labels={a.labels} badge={statusBadge} />
          ) : kind === "Car" ? (
            <div className="relative aspect-[32/15] w-full bg-surface-2">
              <Image src={car.imageUrl ?? "/car-corolla.svg"} alt={fmt(copy.imageAlt, { title: car.title })} fill sizes="(min-width: 1024px) 560px, 100vw" className="object-cover" unoptimized priority />
              <span className="absolute left-3 top-3">{statusBadge}</span>
            </div>
          ) : (
            <div className="relative grid aspect-[32/15] w-full place-items-center bg-surface-2 text-ink-2">
              <span className="flex flex-col items-center gap-2 text-small"><Store className="size-8" aria-hidden="true" />{a.gallery.none}</span>
              <span className="absolute left-3 top-3">{statusBadge}</span>
            </div>
          )}
          <div className="p-4 sm:p-5">
            <Eyebrow>{kind === "Car" ? copy.eyebrow : a.kinds[kind]}</Eyebrow>
            <Heading className="mt-1 text-h2">{title}</Heading>
            {media?.description && <p className="mt-2 whitespace-pre-line text-ink-2"><span className="sr-only">{a.detail.description}: </span>{media.description}</p>}
            {photos[0]?.url.startsWith("blob:") && <p className="mt-2 text-[0.75rem] text-ink-2">{a.photos.localNote}</p>}
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-small text-ink-2">{copy.asking}</p>
                <Money base={car.askingPrice} rate={rate} size="lg" />
              </div>
              {car.status === "Listed" && (
                <p className="min-h-6 rounded-full bg-surface-2 px-3 py-1 text-small font-medium tabular-nums" role="timer" aria-live="off">
                  {remaining === null ? "" : remaining > 0 ? fmt(copy.endsIn, { time: clock(remaining) }) : copy.ended}
                </p>
              )}
            </div>
            {canEdit && !editing && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" small onClick={() => setEditing("photos")}><Pencil className="size-4" aria-hidden="true" />{a.photos.manage}</Button>
                <Button variant="secondary" small onClick={() => setEditing("spec")}><Pencil className="size-4" aria-hidden="true" />{hasSpec(media?.spec) ? a.spec.edit : a.spec.add}</Button>
                <ReleaseAsset asset={car} title={title} />
              </div>
            )}
          </div>
        </Card>

        {canEdit && editing === "photos" && <PhotoEditor copy={a} asset={car} media={media} session={session} role={role} onClose={() => setEditing(null)} />}

        {car.status === "Sold" && sale && (
          <div className="enter [--enter-dur:0.3s] [--from-s:0.97] [--from-y:0]">
            <Card className="border-2 border-ink">
              <p className="flex items-center gap-2 text-h3 font-display"><TickDisc className="size-7" />{copy.sold.title}</p>
              <p className="mt-2 font-medium"><ActivityText item={sale} book={book} /></p>
              <p className="mt-2 text-small text-ink-2">{copy.sold.body}</p>
              {sale.amount !== undefined && (
                <div className="mt-3"><p className="text-small text-ink-2">{copy.sold.price}</p><Money base={sale.amount} rate={rate} size="lg" /></div>
              )}
              {sale.txSignature && <ExplorerLink signature={sale.txSignature} label={copy.sold.receipt} srLabel={copy.sold.receiptSr} />}
              <h3 className="mt-3 flex items-center gap-2 font-sans text-body font-semibold tracking-normal"><FileText className="size-4" aria-hidden="true" />{copy.sold.packTitle}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-small marker:text-ink">
                {copy.sold.pack.map((p) => <li key={p}>{p}</li>)}
              </ul>
              {sellerSide && (
                <div className="mt-3">
                  <ButtonLink href={`/car/handover?asset=${encodeURIComponent(car.address)}`} variant="secondary"><FileText className="size-5" aria-hidden="true" />{copy.sold.openPack}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>
                  <p className="mt-1 text-small text-ink-2">{copy.sold.openPackHint}</p>
                </div>
              )}
              {offers.length > 0 && <p className="mt-3 text-small text-ink-2">{copy.sold.refund}</p>}
            </Card>
          </div>
        )}

        <Protect copy={copy} car={car} offers={offers.map((o) => ({ amount: o.amount, name: buyerName(o) ?? "", mine: o.buyer === session.address }))} owner={e.ownerName.split(" ")[0]} rate={rate} hardshipName={hardshipName} />
      </div>

      <div className="grid gap-5 *:min-w-0">
        {/* What this person can do */}
        {(car.status === "Held" || canList) && (
          canList ? (
            <Card>
              <h2 className="flex items-center gap-2 text-h3"><Store className="size-5 text-amber" aria-hidden="true" />{copy.list.title}</h2>
              <p className="mt-1 text-ink-2">{isVerifier ? copy.list.body : relist ? guardians.rules.sale.relistFamily : guardians.rules.sale.listFamily}</p>
              {relist && isVerifier && <RelistNote />}
              <Button className="mt-3" loading={busy === "list"} onClick={() => run("list", (s, est) => s.listAsset(est, car.address, 7 * 86400), copy.list.done)}>{relist ? guardians.rules.sale.relist : copy.list.cta}</Button>
            </Card>
          ) : (
            <Notice icon={<Lock className="size-5" aria-hidden="true" />}><p className="text-body">{e.status === "Unlocked" ? copy.offers.emptyHeld : copy.list.wait}</p></Notice>
          )
        )}

        {/* The spec sheet sits in this column, beside the photos, so the page is not one long scroll on wide screens. */}
        {canEdit && editing === "spec" && <SpecEditor copy={a} asset={car} media={media} session={session} role={role} onClose={() => setEditing(null)} />}
        {editing !== "spec" && <SpecSheet spec={media?.spec} kind={kind} copy={a.spec} />}

        {car.status === "Listed" && role === "buyer" && <OfferForm copy={copy} car={car} mine={mine?.amount ?? null} />}
        {car.status === "Listed" && (sellerSide || family || isVerifier) && <ShareListing copy={copy} estate={e.address} />}
        {car.status === "Listed" && role !== "buyer" && !family && !isVerifier && <p className="text-small text-ink-2">{copy.offer.onlyBuyers}</p>}
        {car.status === "Sold" && mine && (
          <Card>
            <p className="font-semibold">{copy.offers.you}: {formatUsdt(mine.amount)}</p>
            <Button variant="secondary" className="mt-3" loading={busy === "withdraw"} onClick={() => run("withdraw", (s, est) => s.withdrawOffer(est, car.address), copy.offer.withdrawn)}>{copy.offer.withdraw}</Button>
          </Card>
        )}

        {car.status === "Listed" && (staffed ? isVerifier : family) && (
          <Card>
            <h2 className="flex items-center gap-2 text-h3"><Gavel className="size-5 text-amber" aria-hidden="true" />{copy.settle.title}</h2>
            {staffed || (now !== null && listingEnded(car, now)) ? (
              <CoSign
                snap={snap} asset={car} ranking={offers.length ? ranking : null}
                body={copy.settle.body} cta={copy.settle.cta} working={copy.settle.working} done={copy.settle.done}
                refusalExtra={family && !hardship ? <ButtonLink href="/hardship" small variant="secondary"><HandHeart className="size-4" aria-hidden="true" />{copy.settle.hardshipLink}</ButtonLink> : undefined}
              />
            ) : <p className="mt-1 text-ink-2">{guardians.rules.sale.noSeats}</p>}
          </Card>
        )}

        {/* Offers */}
        {car.status !== "Held" && (
          <Card>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-h3">{copy.offers.title}</h2>
              <span className="text-small text-ink-2 tabular-nums">{offers.length}</span>
            </div>
            {car.status === "Listed" && <PausedNotice target={car.address} className="mt-3" />}
            {offers.length === 0 ? <p className="mt-2 text-ink-2">{copy.offers.empty}</p> : (
              <ul className="mt-2">
                {offers.map((o) => {
                  const st = statusOf(o);
                  const reason = reasonOf(o);
                  return (
                    <li key={o.address} className="enter border-b border-line/70 py-3 last:border-0 [--from-y:6px]">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <p className="min-w-0 font-semibold">{buyerName(o) ?? shortAddress(o.buyer)}{o.buyer === session.address && <span className="ml-2 text-small font-medium text-accent">({copy.offers.you})</span>}</p>
                        <Badge tone={st.tone} className="max-w-full whitespace-normal! py-1">{st.text}</Badge>
                      </div>
                      <p className="tabular-nums">{formatUsdt(o.amount)}{rate ? <span className="ml-2 text-small text-ink-2">≈ {formatZar(o.amount, rate)}</span> : null}</p>
                      {reason && <p className="mt-0.5 text-small text-ink-2">{reason}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            {offers.length > 0 && car.status !== "Sold" && (
              <p className="mt-2 flex items-center gap-1.5 text-[0.75rem] text-ink-2" role="status">
                {ranking ? <ShieldCheck className="size-4 text-amber" aria-hidden="true" /> : <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                {ranking ? copy.offers.ranking : copy.offers.rankingLoading}
              </p>
            )}
          </Card>
        )}

        {/* Hardship */}
        {hardship ? (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-h3"><HandHeart className="size-5 text-amber" aria-hidden="true" />{copy.hardship.title}</h2>
              <Badge tone={hardship.status === "Approved" ? "ok" : "warn"}>{common.status.hardship[hardship.status]}</Badge>
            </div>
            <p className="mt-1 text-ink-2">{fmt(copy.hardship.from, { name: snap.beneficiaries.find((b) => b.wallet === hardship.beneficiary)?.label ?? "" })}</p>
            <ReferredNote verdict={hardship.agentVerdict} />
            {hardship.status === "Open" && <div className="mt-3"><VoteTally tally={hardshipTally(e, hardship)} names={e.verifierNames} /></div>}
          </Card>
        ) : family && car.status !== "Sold" && e.status === "Unlocked" ? (
          <Card className="bg-surface-2/50">
            <p className="text-small text-ink-2">{copy.hardship.linkBody}</p>
            <ButtonLink href="/hardship" variant="secondary" small className="mt-3"><HandHeart className="size-4" aria-hidden="true" />{copy.hardship.link}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- The floor, drawn ---------- */

function Protect({ copy, car, offers, owner, rate, hardshipName }: {
  copy: Copy; car: Asset; offers: { amount: bigint; name: string; mine: boolean }[]; owner: string; rate: number | null; hardshipName: string;
}) {
  const p = copy.protect;
  const h = fromBase(car.hardshipFloor), f = fromBase(car.floorPrice), a = fromBase(car.askingPrice);
  const top = Math.max(a, ...offers.map((o) => fromBase(o.amount)));
  const bottom = Math.min(h, ...offers.map((o) => fromBase(o.amount)));
  const min = bottom - (top - bottom) * 0.12, max = top + (top - bottom) * 0.1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  const relaxed = !!car.hardshipBeneficiary;
  const legend = [
    { swatch: "bg-ink", label: p.blockedZone, value: `< ${formatUsdt(relaxed ? car.hardshipFloor : car.floorPrice, { decimals: 0 })}` },
    ...(relaxed ? [] : [{ swatch: "bg-line-strong", label: p.hardshipZone, value: `${formatUsdt(car.hardshipFloor, { decimals: 0 }).replace(" USD₮", "")} – ${formatUsdt(car.floorPrice, { decimals: 0 })}` }]),
    { swatch: "bg-surface", label: p.openZone, value: `≥ ${formatUsdt(relaxed ? car.hardshipFloor : car.floorPrice, { decimals: 0 })}` },
  ];
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-h3"><ShieldCheck className="size-5 text-amber" aria-hidden="true" />{p.title}</h2>
      <p className="mt-1 text-ink-2">{fmt(p.body, { owner })}</p>
      {relaxed && <Notice tone="warn" className="mt-3"><p className="text-body">{fmt(p.hardshipOn, { name: hardshipName, floor: formatUsdt(car.hardshipFloor, { decimals: 0 }) })}</p></Notice>}

      <div className="mt-12" role="img" aria-label={p.scaleLabel}>
        <div className="relative h-4 rounded-full">
          <div className="absolute inset-0 flex overflow-hidden rounded-full border border-ink bg-surface">
            <span className="h-full bg-ink" style={{ width: pos(h) }} />
            <span className={clsx("h-full", relaxed ? "bg-surface" : "bg-line-strong")} style={{ width: `calc(${pos(f)} - ${pos(h)})` }} />
            <span className="h-full flex-1 bg-surface" />
          </div>
          {[{ v: h, label: p.hardshipFloor }, { v: f, label: p.floor }, { v: a, label: p.asking }].map((m, i) => (
            <span key={m.label} className="absolute -bottom-1.5 -top-1.5 w-0.5 bg-ink" style={{ left: pos(m.v) }}>
              <span className={clsx("absolute top-full mt-1 w-max max-w-[5.5rem] hyphens-auto break-words text-[0.7rem] font-semibold leading-tight", i === 0 ? "left-0 -translate-x-1/4" : i === 2 ? "right-0 translate-x-1/4 text-right" : "left-1/2 -translate-x-1/2 text-center")}>
                {m.label}<br /><span className="font-normal tabular-nums text-ink-2">{m.v.toLocaleString("en-ZA")}</span>
              </span>
            </span>
          ))}
          {offers.map((o, i) => {
            const v = fromBase(o.amount);
            const ok = v >= (relaxed ? h : f);
            return (
              <span
                key={`${o.name}-${i}`}
                className={clsx("enter absolute bottom-full mb-1.5 grid size-7 -translate-x-1/2 place-items-center border-2 border-ink text-[0.7rem] font-bold [--enter-dur:0.4s] [--from-y:-14px]", ok ? "rounded-full bg-surface text-ink" : "rounded-[3px] bg-ink text-bg", o.mine && "ring-2 ring-ink ring-offset-2 ring-offset-surface")}
                style={{ left: pos(v), "--enter-delay": `${i * 0.06}s` } as CSSProperties} title={`${o.name}: ${v.toLocaleString("en-ZA")} USD₮`}
              >
                {o.name[0] ?? "?"}
              </span>
            );
          })}
        </div>
      </div>

      <ul className="mt-14 grid gap-1.5 text-small">
        {legend.map((l) => (
          <li key={l.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2"><span className={clsx("size-3 shrink-0 rounded-full border border-ink", l.swatch)} aria-hidden="true" />{l.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{l.value}</span>
          </li>
        ))}
      </ul>
      {rate && <p className="mt-2 text-[0.75rem] text-ink-2">{p.floor}: ≈ {formatZar(car.floorPrice, rate)} · {p.hardshipFloor}: ≈ {formatZar(car.hardshipFloor, rate)}</p>}
    </Card>
  );
}

/* ---------- Buyer: escrowed offer ---------- */

/** The link a seller sends to buyers: it opens this estate's listing for anyone, family or not (?estate=). */
function ShareListing({ copy, estate }: { copy: Copy; estate: string }) {
  const s = copy.share;
  const [copied, setCopied] = useState(false);
  // Rendered only in the browser, once the estate has loaded (never server-side), so the origin is known here.
  const link = typeof window === "undefined" ? "" : listingLink(window.location.origin, estate);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 3000); } catch { /* the link is shown to copy by hand */ }
  };
  return (
    <Card>
      <h2 className="text-h3">{s.title}</h2>
      <p className="mt-1 text-small text-ink-2">{s.body}</p>
      <label htmlFor="listing-link" className="sr-only">{s.label}</label>
      <input id="listing-link" readOnly value={link} onFocus={(ev) => ev.currentTarget.select()} className={`${inputClass} mt-3 font-mono text-small`} />
      <Button variant="secondary" small className="mt-3" onClick={() => void copyLink()} disabled={!link}>{s.copy}</Button>
      <p className="mt-1 text-small text-ink-2" role="status">{copied ? s.copied : ""}</p>
    </Card>
  );
}

function OfferForm({ copy, car, mine }: { copy: Copy; car: Asset; mine: bigint | null }) {
  const { common } = useCopy();
  const { fx, run, busy, walletUsdt, session } = useEstate();
  const o = copy.offer;
  const { pay } = usePay();
  const rate = fx?.usdtZar ?? null;
  const [amount, setAmount] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = num(amount);
  const valid = Number.isFinite(n) && n > 0;
  const spendable = walletUsdt + (mine ?? BigInt(0));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!valid || toBase(n) > spendable) { setError(amount.trim() && Number.isNaN(n) ? common.amountUnclear : o.error); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await pay({
      kind: "offer", to: car.address, toLabel: `${o.escrowLabel}: ${car.title}`, amount: toBase(n),
      warnings: toBase(n) < car.floorPrice ? [fmt(o.belowFloor, { floor: formatUsdt(car.floorPrice, { decimals: 0 }) })] : [],
      // The buyer's own name travels with the offer, so the family sees "Pieter van Wyk", not a wallet address.
      execute: (s, est) => s.placeOffer(est, car.address, n, session ? fullName(session.label) || undefined : undefined), successText: o.placed,
    });
    if (res.ok) setAmount("");
  };

  return (
    <Card className="border-accent/40">
      <h2 className="text-h3">{o.title}</h2>
      <p className="mt-1 text-small text-ink-2">{o.body}</p>
      {mine !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-accent-soft p-3">
          <p className="font-semibold">{copy.offers.you}: <span className="tabular-nums">{formatUsdt(mine)}</span></p>
          <Button variant="secondary" small loading={busy === "withdraw"} onClick={() => run("withdraw", (s, est) => s.withdrawOffer(est, car.address), o.withdrawn)}>{o.withdraw}</Button>
        </div>
      )}
      <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
        <Field label={o.amount} htmlFor="offer-amount" error={error} hint={`${amountHint(amount, (x) => (x > 0 ? `= ${formatUsdtExact(toBase(x))}${rate ? ` · ${fmt(o.zar, { zar: formatZar(toBase(x), rate) })}` : ""}` : undefined), { unclear: common.amountUnclear, format: common.amountFormat }) ?? ""} · ${fmt(o.wallet, { amount: formatUsdt(walletUsdt, { decimals: 0 }) })}`.replace(/^ · /, "")}>
          <div className="relative">
            <input
              id="offer-amount" inputMode="decimal" autoComplete="off" placeholder={amountText(fromBase(car.askingPrice))} value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null); }}
              aria-invalid={!!error} aria-describedby={error ? "offer-amount-error" : "offer-amount-hint"}
              className={`${inputClass} min-h-16 pr-20 font-display text-h2 tabular-nums`}
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-ink-2">USD₮</span>
          </div>
        </Field>
        {valid && toBase(n) < car.floorPrice && (
          <Notice tone="warn"><p role="status">{fmt(o.belowFloor, { floor: formatUsdt(car.floorPrice, { decimals: 0 }) })}</p></Notice>
        )}
        <Consent id="offer-consent" checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
        <Button type="submit" disabled={!!busy} className="min-h-13!"><Lock className="size-5" aria-hidden="true" />{mine !== null ? o.update : o.submit}</Button>
      </form>
    </Card>
  );
}
