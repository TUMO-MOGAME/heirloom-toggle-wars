/**
 * An asset's spec sheet for family and buyers: a key-facts row, then Details, Condition and (vehicles) Performance
 * as definition lists, laid out for the asset's kind (SPEC_LAYOUTS). Only filled-in fields are shown. Values come from the owner (data); labels, units and enum
 * names come from content/assets.ts.
 */
import { ScrollText } from "@/components/ui/icons";
import { Card } from "@/components/ui/primitives";
import { fmt } from "@/components/shell/copy";
import type { AssetsCopy } from "@/content/assets";
import { cleanSpec, SPEC_LAYOUTS, type AssetSpec, type SpecKey } from "@/lib/assets/spec";
import type { AssetKind } from "@/lib/guardians/types";

type SpecCopy = AssetsCopy["spec"];

/** One value as text: enum names and units from the copy, numbers in South African format (124 455). */
export function specValue(key: SpecKey, value: AssetSpec[SpecKey], copy: SpecCopy): string {
  if (value === undefined) return "";
  const values = copy.values as Record<string, Record<string, string> | undefined>;
  if (typeof value === "boolean") return values[key]?.[value ? "yes" : "no"] ?? String(value);
  const named = values[key]?.[String(value)];
  if (named) return named;
  if (typeof value === "number") {
    const n = key === "year" ? String(value) : value.toLocaleString("en-ZA", { maximumFractionDigits: 1 });
    const unit = (copy.units as Record<string, string | undefined>)[key];
    return unit ? fmt(unit, { v: n }) : n;
  }
  return value;
}

const filled = (spec: AssetSpec, keys: readonly SpecKey[]) => keys.filter((k) => spec[k] !== undefined);
/** Free text shown on its own line under the label. */
const LONG: readonly SpecKey[] = ["roadworthyNotes", "knownFaults", "keySpecs", "includes", "stones"];

export function SpecSheet({ spec: raw, kind, copy, headingLevel = 2 }: { spec?: AssetSpec; kind: AssetKind; copy: SpecCopy; headingLevel?: 2 | 3 }) {
  const spec = cleanSpec(raw);
  if (!spec) return null;
  const H = headingLevel === 2 ? "h2" : "h3";
  const S = headingLevel === 2 ? "h3" : "h4";
  const layout = SPEC_LAYOUTS[kind];
  const facts = filled(spec, layout.keyFacts ?? []);
  const sections = (["details", "condition", "performance"] as const).map((s) => ({ s, keys: filled(spec, layout[s] ?? []) })).filter((x) => x.keys.length);
  return (
    <Card>
      <H className="flex items-center gap-2 text-h3"><ScrollText className="size-5 text-amber" aria-hidden="true" />{copy.title}</H>
      {facts.length > 0 && (
        <>
          <S className="sr-only">{copy.keyFacts}</S>
          <dl className="mt-3 grid grid-cols-2 gap-2 min-[480px]:grid-cols-3">
            {facts.map((k) => (
              <div key={k} className="min-w-0 rounded-md border border-line-strong bg-surface-2 px-3 py-2">
                <dt className="hyphens-auto break-words text-[0.75rem] font-semibold uppercase tracking-[0.06em] text-ink-2">{copy.fields[k]}</dt>
                <dd className="mt-0.5 break-words font-semibold tabular-nums">{specValue(k, spec[k], copy)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {sections.map(({ s, keys }) => (
        <section key={s} className="mt-4">
          <S className="font-sans text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.sections[s]}</S>
          <dl className="mt-1">
            {keys.map((k) => (
              <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line/70 py-2 last:border-0">
                <dt className="text-small text-ink-2">{copy.fields[k]}</dt>
                <dd className={LONG.includes(k) ? "w-full text-small" : "text-right font-medium tabular-nums"}>{specValue(k, spec[k], copy)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Card>
  );
}
