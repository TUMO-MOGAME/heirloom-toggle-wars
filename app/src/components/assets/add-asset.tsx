"use client";
/**
 * Owner, estate Active: add any asset to be sold after their death. Kind, name, description, the three prices
 * (asking ≥ minimum ≥ hardship floor, enforced on-chain), registration papers for vehicles, up to 24 labelled photos and,
 * an optional spec sheet laid out for the kind (vehicle, furniture, jewellery, electronics, other).
 * Cars and motorbikes can get the AI valuation first (it fills the prices); other kinds are priced by the owner.
 */
import { useState, type FormEvent } from "react";
import clsx from "clsx";
import { m as motion, useReducedMotion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import { Lock, Sparkles } from "@/components/ui/icons";
import { Button, Card, Consent, Eyebrow, Field, inputClass, Money, PageHeader } from "@/components/ui/primitives";
import { FilePicker } from "@/components/ui/client";
import { SpecialistChip } from "@/components/agent/chat-parts";
import { fmt, useCopy } from "@/components/shell/copy";
import type { AssetsCopy } from "@/content/assets";
import type { ScreensCopy } from "@/content/screens";
import type { EstateSnapshot } from "@/lib/service";
import type { AssetKind } from "@/lib/guardians/types";
import type { CarValuation, Role, WalletSession } from "@/lib/types";
import { formatUsdt, formatUsdtExact, formatZar, toBase } from "@/lib/format";
import { amountHint, amountText, parseAmount } from "@/lib/amount";
import { useEstate } from "@/lib/hooks/estate";
import { ASSET_KINDS, MAX_DESCRIPTION, VALUED_KINDS } from "@/lib/media/api";
import { PhotoUploader, type DraftPhoto } from "./photo-uploader";
import { SpecFields } from "./spec-editor";
import type { SpecKey } from "@/lib/assets/spec";
import { draftFromVehicle, draftToSpec, specToDraft, type SpecDraft } from "@/lib/assets/spec-form";
import { savePhotos } from "./media";
import { nextPlanned, proceedsFromPlan } from "@/lib/assets/planned";

const num = (s: string) => parseAmount(s) ?? Number.NaN;

/** Animated with motion, so it brings its own <MotionScope> (the first pages never load the library). */
export function AddAsset(props: Parameters<typeof AddAssetBody>[0]) {
  return <MotionScope><AddAssetBody {...props} /></MotionScope>;
}

function AddAssetBody({ car, copy, snap, session, role, onCancel, onAdded }: {
  car: ScreensCopy["car"]; copy: AssetsCopy; snap: EstateSnapshot; session: WalletSession; role: Role;
  onCancel?: () => void; onAdded?: (asset: string) => void;
}) {
  const { common, assistant } = useCopy();
  const { service, fx, run, busy, explain, notify } = useEstate();
  const reduce = useReducedMotion();
  const r = car.register, a = copy.add;
  const rate = fx?.usdtZar ?? null;
  const [kind, setKind] = useState<AssetKind>("Car");
  const vehicle = VALUED_KINDS.includes(kind);
  const [make, setMake] = useState<string>(r.defaults.make);
  const [model, setModel] = useState<string>(r.defaults.model);
  const [year, setYear] = useState<string>(r.defaults.year);
  const [mileage, setMileage] = useState<string>(r.defaults.mileage);
  const [condition, setCondition] = useState<string>(r.conditions[1]);
  // The signed plan's asset, not added yet (M4): its name, prices and who gets the money are filled in.
  const [plan] = useState(() => nextPlanned(snap.plannedAssets, snap.assets));
  const [title, setTitle] = useState(plan?.title ?? "");
  const [titleTouched, setTitleTouched] = useState(!!plan);
  const [proceeds, setProceeds] = useState<string>(() => (plan ? proceedsFromPlan(plan.proceedsTo, snap.estate.address, snap.beneficiaries) : snap.estate.address) ?? "");
  const [description, setDescription] = useState("");
  const [valuing, setValuing] = useState(false);
  const [valuation, setValuation] = useState<CarValuation | null>(null);
  // Shown beside the valuation button, not with the form's errors further down, so a failed valuation is seen.
  const [valuationError, setValuationError] = useState<string | null>(null);
  const [asking, setAsking] = useState(plan ? amountText(plan.askingPriceUsdt) : "");
  const [floor, setFloor] = useState(plan ? amountText(plan.floorPriceUsdt) : "");
  const [hardship, setHardship] = useState(plan ? amountText(plan.hardshipFloorUsdt) : "");
  const [doc, setDoc] = useState<File | null>(null);
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [specDraft, setSpecDraft] = useState<SpecDraft>(() => specToDraft());
  const [specTouched, setSpecTouched] = useState(false);
  const [specInvalid, setSpecInvalid] = useState<SpecKey[]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  // Switching between car and motorbike swaps the starting make, model, year and mileage, unless the owner changed them.
  const pickKind = (k: AssetKind) => {
    const from = kind === "Motorbike" ? a.motorbikeDefaults : r.defaults;
    const to = k === "Motorbike" ? a.motorbikeDefaults : r.defaults;
    if (from !== to && make === from.make && model === from.model && year === from.year && mileage === from.mileage) {
      setMake(to.make); setModel(to.model); setYear(to.year); setMileage(to.mileage);
    }
    setKind(k); setValuation(null); setError(null);
  };

  // Vehicles: the name follows make/model/year until the owner types their own.
  const name = vehicle && !titleTouched ? `${year} ${make} ${model}`.trim() : title.trim();

  const value = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (!service) return;
    setValuing(true); setError(null); setValuationError(null);
    try {
      const v = await service.valueCar({ make, model, year: Number(year), mileageKm: num(mileage), condition, kind });
      setValuation(v);
      // The plan's own prices stand: the valuation is advice beside them.
      if (!plan) {
        setAsking(amountText(v.suggestedAskingUsdt));
        setFloor(amountText(v.lowUsdt));
        setHardship(amountText(Math.round(v.lowUsdt * 0.84 / 50) * 50));
      }
    } catch {
      // A timeout or a busy agent: the owner can try again or type the prices.
      setValuationError(r.valuationFailed);
    } finally {
      setValuing(false);
    }
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const ask = num(asking), f = num(floor), h = num(hardship);
    if (!name) { setError(a.titleError); return; }
    if ([asking, floor, hardship].some((t) => t.trim() && Number.isNaN(num(t)))) { setError(common.amountUnclear); return; }
    if (!(h > 0 && f >= h && ask >= f)) { setError(r.orderError); return; }
    // The spec sheet counts once the owner has typed in it, and only with this kind's fields.
    const sheet = specTouched ? draftToSpec(specDraft, kind) : { spec: undefined, invalid: [] as SpecKey[] };
    setSpecInvalid(sheet.invalid);
    if (sheet.invalid.length) {
      setError(null);
      requestAnimationFrame(() => document.getElementById(`asset-spec-${sheet.invalid[0]}`)?.focus());
      return;
    }
    if (!proceeds) { setError(a.proceeds); document.getElementById("asset-proceeds")?.focus(); return; }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    let photoError: string | null = null;
    setStage(a.working);
    const res = await run("register", async (s, est) => {
      const before = new Set(snap.assets.map((x) => x.address));
      await s.registerAsset(est, {
        nftMint: "", title: name, floorUsdt: f, hardshipFloorUsdt: h, askingUsdt: ask, proceedsTo: proceeds,
        docFile: vehicle ? doc ?? undefined : undefined,
      });
      const added = (await s.getEstate(est)).assets.find((x) => !before.has(x.address));
      if (!added) return null;
      // The asset is on the estate now; a photo failure is reported but does not undo it (photos can be added later).
      // Nothing to record when the owner added no photos and no spec sheet (and the demo car keeps its own).
      if (photos.length === 0 && !sheet.spec) return added.address;
      try {
        await savePhotos({
          service: s, estate: est, session, role, asset: added.address, kind, title: name, description: description.trim(),
          items: photos, spec: sheet.spec, onProgress: (done, total) => setStage(total ? fmt(a.uploading, { done, total }) : a.saving),
        });
      } catch (e) {
        photoError = explain(e).message;
      }
      return added.address;
    }, fmt(a.added, { title: name }));
    setStage(null);
    if (!res.ok) return;
    if (photoError) notify("error", fmt(a.photosFailed, { title: name, reason: photoError }));
    if (res.value) onAdded?.(res.value);
  };

  const zar = (s: string) => amountHint(s, (x) => (x > 0 ? `= ${formatUsdtExact(toBase(x))}${rate ? ` · ${fmt(r.zar, { zar: formatZar(toBase(x), rate) })}` : ""}` : undefined), { unclear: common.amountUnclear, format: common.amountFormat });
  const working = busy === "register";

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow={copy.eyebrow} title={a.title} body={a.body} />
      {plan && <p role="status" className="mb-4 rounded-md border-[1.5px] border-dashed border-ink p-3 text-small font-semibold">{a.fromPlan}</p>}
      <div className="grid gap-4 *:min-w-0">
        <Card>
          <fieldset className="min-w-0">
            <legend className="text-small font-semibold">{a.kindLegend}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 min-[480px]:grid-cols-3">
              {ASSET_KINDS.map((k) => (
                <label key={k} className={clsx(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-small font-medium focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]",
                  kind === k ? "border-2 border-ink bg-surface-2" : "border-line-strong bg-surface hover:bg-surface-2",
                )}>
                  <input type="radio" name="asset-kind" value={k} checked={kind === k} onChange={() => pickKind(k)} className="size-4 accent-[var(--ink)]" />
                  {copy.kinds[k]}
                </label>
              ))}
            </div>
          </fieldset>
          {vehicle && <p className="mt-3 text-small text-ink-2">{a.vehicleNote}</p>}
        </Card>

        {vehicle && (
          <Card>
            <form onSubmit={value} className="grid gap-3 sm:grid-cols-2">
              <Field label={r.make} htmlFor="car-make"><input id="car-make" required value={make} onChange={(e) => setMake(e.target.value)} className={inputClass} /></Field>
              <Field label={r.model} htmlFor="car-model"><input id="car-model" required value={model} onChange={(e) => setModel(e.target.value)} className={inputClass} /></Field>
              <Field label={r.year} htmlFor="car-year"><input id="car-year" required inputMode="numeric" pattern="\d{4}" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} className={inputClass} /></Field>
              <Field label={r.mileage} htmlFor="car-km"><input id="car-km" required inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value)} className={inputClass} /></Field>
              <Field label={r.condition} htmlFor="car-cond" className="sm:col-span-2">
                <select id="car-cond" value={condition} onChange={(e) => setCondition(e.target.value)} className={inputClass}>
                  {r.conditions.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Button type="submit" variant={valuation ? "secondary" : "primary"} loading={valuing} className="sm:col-span-2">
                <Sparkles className="size-5" aria-hidden="true" />{valuing ? r.valuing : valuation ? r.revalue : r.value}
              </Button>
            </form>
            {valuationError && !valuing && <p role="alert" className="mt-3 border-l-4 border-ink pl-2 text-small font-semibold text-ink">{valuationError}</p>}
            <p className="sr-only" role="status" aria-live="polite">{valuing ? r.valuing : valuation ? `${r.valuationTitle}: ${valuation.suggestedAskingUsdt} USD₮` : ""}</p>
          </Card>
        )}

        {vehicle && valuation && !valuing && (
          <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Eyebrow>{r.valuationTitle}</Eyebrow>
                <SpecialistChip name="CarBroker" copy={assistant} />
              </div>
              <Money base={toBase(valuation.suggestedAskingUsdt)} rate={rate} size="xl" className="mt-1" />
              <p className="mt-1 text-small text-ink-2">{fmt(r.range, { low: formatUsdt(toBase(valuation.lowUsdt), { decimals: 0 }), high: formatUsdt(toBase(valuation.highUsdt), { decimals: 0 }) })}</p>
              <p className="mt-3">{valuation.estimate ? r.estimateNote : valuation.rationale}</p>
              {valuation.comparables.length > 0 && <h3 className="mt-4 font-sans text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{r.comparables}</h3>}
              <ul className="mt-1">
                {valuation.comparables.map((c) => (
                  <li key={c.title} className="flex items-center justify-between gap-3 border-b border-line/70 py-2 text-small last:border-0">
                    <span className="min-w-0"><span className="block truncate font-medium">{c.title}</span><span className="text-ink-2">{c.source}</span></span>
                    <span className="shrink-0 font-semibold tabular-nums">R {c.priceZar.toLocaleString("en-ZA")}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </motion.div>
        )}

        <Card>
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field label={a.titleLabel} htmlFor="asset-title" hint={a.titleHint}>
              <input id="asset-title" value={vehicle && !titleTouched ? name : title} maxLength={120} placeholder={a.titlePlaceholder[kind]}
                onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); setError(null); }} className={inputClass} />
            </Field>
            <Field label={a.description} htmlFor="asset-desc" hint={a.descriptionHint}>
              <textarea id="asset-desc" rows={3} maxLength={MAX_DESCRIPTION} value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} min-h-24 py-2`} />
            </Field>

            <h2 className="text-h3">{a.pricesTitle}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={r.asking} htmlFor="car-asking" hint={zar(asking)}><input id="car-asking" inputMode="numeric" value={asking} onChange={(e) => setAsking(e.target.value)} className={`${inputClass} tabular-nums`} /></Field>
              <Field label={r.floor} htmlFor="car-floor" hint={zar(floor) ?? r.floorHint}><input id="car-floor" inputMode="numeric" value={floor} onChange={(e) => setFloor(e.target.value)} className={`${inputClass} tabular-nums`} /></Field>
              <Field label={r.hardship} htmlFor="car-hard" hint={zar(hardship) ?? r.hardshipHint}><input id="car-hard" inputMode="numeric" value={hardship} onChange={(e) => setHardship(e.target.value)} className={`${inputClass} tabular-nums`} /></Field>
            </div>
            {(zar(floor) || zar(hardship)) && <p className="text-small text-ink-2">{r.floorHint} {r.hardshipHint}</p>}
            <Field label={a.proceeds} htmlFor="asset-proceeds">
              <select id="asset-proceeds" value={proceeds} onChange={(e) => { setProceeds(e.target.value); setError(null); }} className={inputClass}>
                {!proceeds && <option value="">{a.proceeds}</option>}
                <option value={snap.estate.address}>{a.proceedsVault}</option>
                {snap.beneficiaries.filter((b) => b.active).map((b) => <option key={b.wallet} value={b.wallet}>{b.label}</option>)}
              </select>
            </Field>
            {vehicle && <FilePicker id="car-doc" label={r.doc} hint={r.docHint} file={doc} onFile={setDoc} samples={r.docSamples} copy={common.file} />}

            <PhotoUploader id="asset-photos" copy={copy.photos} labels={copy.labels} title={name} items={photos} onChange={setPhotos} disabled={working} />
            <details className="rounded-md border border-line-strong bg-surface p-3" onToggle={(e) => { if (e.currentTarget.open && !specTouched && vehicle) setSpecDraft(draftFromVehicle({ make, model, year, mileage })); }}>
              <summary className="min-h-11 cursor-pointer content-center font-semibold">{copy.spec.optional}</summary>
              <p className="mt-1 text-small text-ink-2">{copy.spec.optionalBody}</p>
              <div className="mt-3">
                <SpecFields id="asset-spec" kind={kind} copy={copy.spec} draft={specDraft} onChange={(d) => { setSpecDraft(d); setSpecTouched(true); setSpecInvalid([]); setError(null); }} invalid={specInvalid} disabled={working} />
              </div>
          </details>
            <p className="text-small text-ink-2">{copy.photos.onchainNote}</p>

            <Consent id="asset-consent" checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
            {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
            <p className="sr-only" role="status" aria-live="polite">{stage ?? ""}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={working}><Lock className="size-5" aria-hidden="true" />{working && stage ? stage : a.submit}</Button>
              {onCancel && <Button variant="ghost" onClick={onCancel} disabled={working}>{a.cancel}</Button>}
            </div>
            {vehicle && <p className="text-small text-ink-2">{r.titleNote}</p>}
          </form>
        </Card>
      </div>
    </div>
  );
}
