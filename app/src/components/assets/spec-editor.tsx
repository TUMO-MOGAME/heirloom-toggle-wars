"use client";
/**
 * The owner's spec sheet form. `SpecFields` is the fields alone (used inside "Add an asset" and here);
 * `SpecEditor` is the card for an asset already on the estate (estate Active): it saves the sheet together with the
 * asset's current photos, so the media root on-chain covers both.
 */
import { useState, type FormEvent } from "react";
import { Button, Card, Consent, Field, inputClass } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import type { AssetsCopy } from "@/content/assets";
import { useEstate } from "@/lib/hooks/estate";
import type { Asset, Role, WalletSession } from "@/lib/types";
import type { AssetMediaView } from "@/lib/media/api";
import { SPEC_LAYOUTS, SPEC_SECTIONS, type SpecKey } from "@/lib/assets/spec";
import type { AssetKind } from "@/lib/guardians/types";
import { CHOICES, DECIMAL_FIELDS, draftToSpec, INT_FIELDS, LONG_TEXT_FIELDS, specToDraft, type SpecDraft } from "@/lib/assets/spec-form";
import { draftFromStored } from "./photo-uploader";
import { kindOf, savePhotos } from "./media";

type SpecCopy = AssetsCopy["spec"];

function optionLabel(key: SpecKey, value: string, copy: SpecCopy): string {
  const values = copy.values as Record<string, Record<string, string> | undefined>;
  return values[key]?.[value] ?? value;
}

export function SpecFields({ id, kind, copy, draft, onChange, invalid = [], disabled = false }: {
  id: string; kind: AssetKind; copy: SpecCopy; draft: SpecDraft; onChange: (d: SpecDraft) => void; invalid?: readonly SpecKey[]; disabled?: boolean;
}) {
  const layout = SPEC_LAYOUTS[kind];
  const set = (k: SpecKey, v: string) => onChange({ ...draft, [k]: v });
  const units = copy.inputUnits as Record<string, string | undefined>;
  const hints = copy.hints as Record<string, string | undefined>;
  return (
    <div className="flex flex-col gap-4">
      {SPEC_SECTIONS.filter((s) => layout[s]?.length).map((s) => (
        <fieldset key={s} className="min-w-0">
          <legend className="font-sans text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.sections[s]}</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(layout[s] ?? []).map((k) => {
              const fid = `${id}-${k}`;
              const bad = invalid.includes(k);
              const unit = units[k];
              const label = unit ? `${copy.fields[k]} (${unit})` : copy.fields[k];
              const error = bad ? fmt(copy.invalid, { field: copy.fields[k] }) : null;
              const common = {
                id: fid, disabled, value: draft[k], "aria-invalid": bad || undefined,
                "aria-describedby": bad ? `${fid}-error` : hints[k] ? `${fid}-hint` : undefined,
              };
              const choices = CHOICES[k];
              return (
                <Field key={k} label={label} htmlFor={fid} hint={hints[k]} error={error} className={LONG_TEXT_FIELDS.includes(k) ? "sm:col-span-2" : undefined}>
                  {choices ? (
                    <select {...common} onChange={(e) => set(k, e.target.value)} className={inputClass}>
                      <option value="">{copy.notSet}</option>
                      {choices.map((c) => <option key={c} value={c}>{optionLabel(k, c, copy)}</option>)}
                    </select>
                  ) : LONG_TEXT_FIELDS.includes(k) ? (
                    <textarea {...common} rows={2} maxLength={400} onChange={(e) => set(k, e.target.value)} className={`${inputClass} min-h-20 py-2`} />
                  ) : (
                    <input
                      {...common} onChange={(e) => set(k, e.target.value)} autoComplete="off"
                      inputMode={INT_FIELDS.includes(k) ? "numeric" : DECIMAL_FIELDS.includes(k) ? "decimal" : undefined}
                      maxLength={INT_FIELDS.includes(k) || DECIMAL_FIELDS.includes(k) ? 12 : 60}
                      className={`${inputClass} ${INT_FIELDS.includes(k) || DECIMAL_FIELDS.includes(k) ? "tabular-nums" : ""}`}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export function SpecEditor({ copy, asset, media, session, role, onClose }: {
  copy: AssetsCopy; asset: Asset; media?: AssetMediaView; session: WalletSession; role: Role; onClose: () => void;
}) {
  const { common } = useCopy();
  const { run, busy } = useEstate();
  const c = copy.spec;
  const title = media?.title || asset.title;
  const [draft, setDraft] = useState<SpecDraft>(() => specToDraft(media?.spec));
  const [invalid, setInvalid] = useState<SpecKey[]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = busy === "spec";

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const { spec, invalid: bad } = draftToSpec(draft, kindOf(media));
    setInvalid(bad);
    if (bad.length) {
      // Each invalid field shows its own message; move focus to the first one.
      setError(null);
      requestAnimationFrame(() => document.getElementById(`spec-edit-${bad[0]}`)?.focus());
      return;
    }
    if (!consent) { setError(common.consentRequired); return; }
    setError(null);
    const res = await run("spec", (service, estate) => savePhotos({
      service, estate, session, role, asset: asset.address, kind: kindOf(media), title, description: media?.description ?? "",
      items: (media?.photos ?? []).map(draftFromStored), spec,
    }), c.saved, true);
    if (res.ok) onClose();
    else setError(res.message);
  };

  return (
    <Card>
      <h2 className="text-h3">{fmt(c.editTitle, { title })}</h2>
      <p className="mt-1 text-small text-ink-2">{c.editBody}</p>
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
        <SpecFields id="spec-edit" kind={kindOf(media)} copy={c} draft={draft} onChange={(d) => { setDraft(d); setError(null); }} invalid={invalid} disabled={working} />
        <p className="text-small text-ink-2">{c.onchainNote}</p>
        <Consent id="spec-edit-consent" checked={consent} onChange={(v) => { setConsent(v); setError(null); }} copy={common.consent} />
        {error && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold text-ink">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={working}>{working ? c.saving : c.save}</Button>
          <Button variant="ghost" onClick={onClose} disabled={working}>{copy.add.cancel}</Button>
        </div>
      </form>
    </Card>
  );
}
