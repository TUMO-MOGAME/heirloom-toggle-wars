"use client";
/**
 * The estate switcher: shown only when the acting wallet belongs to more than one estate (a child named in a
 * grandparent's and a parent's plan, a trusted person for two families, a daughter with her own plan). The choice
 * is remembered on this device (heirloom.lastEstate, lib/hooks/estate.tsx).
 */
import { useEstate } from "@/lib/hooks/estate";
import type { Role } from "@/lib/types";
import { fmt, useCopy } from "./copy";

/** `inset`: the chat home's main has no padding of its own, so the switcher brings its own. */
export function EstateSwitcher({ inset = false }: { inset?: boolean }) {
  const { common } = useCopy();
  const { estates, estate, chooseEstate, session } = useEstate();
  if (!session || estates.length < 2) return null;
  const c = common.estateSwitcher;
  const listed = estates.some((x) => x.estate === estate);
  return (
    <div className={inset ? "mx-auto w-full max-w-6xl px-4 pt-3" : "mb-4"}>
      <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small">
        <span className="font-semibold">{c.label}</span>
        <select
          value={listed ? estate ?? "" : ""}
          onChange={(e) => { if (e.target.value) chooseEstate(e.target.value); }}
          className="min-h-11 min-w-0 max-w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-small text-ink transition-colors hover:border-ink focus:border-ink"
        >
          {!listed && <option value="" disabled>{c.other}</option>}
          {estates.map((x) => (
            <option key={x.estate} value={x.estate}>
              {x.role === "owner" ? c.yours : fmt(c.option, { name: x.ownerName, role: common.roles[x.role as Role] ?? x.role })}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
