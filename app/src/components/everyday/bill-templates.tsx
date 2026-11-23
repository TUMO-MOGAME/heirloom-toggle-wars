"use client";
/**
 * Ready-made bills (plan.md §13.3): one tap picks a template, which opens its pre-filled form (bill-sheet.tsx,
 * loaded only then); a second tap adds it. Used by the plan builder (draft) and the signed plan.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { BookOpen, GraduationCap, HeartHandshake, House, Scale, Stethoscope, type LucideIcon } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { TEMPLATE_KEYS, type TemplateKey } from "@/lib/everyday/templates";
import type { BillTarget } from "./bill-sheet";

const BillSheet = dynamic(() => import("./bill-sheet"), { ssr: false });

const ICON: Record<TemplateKey, LucideIcon> = {
  funeral: HeartHandshake, parent: House, medical: Stethoscope, school: GraduationCap, books: BookOpen, legal: Scale,
};

export function BillTemplates({ copy, target, disabled = false, compact = false }: { copy: ScreensCopy["bills"]; target: BillTarget; disabled?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState<TemplateKey | null>(null);
  return (
    <>
      <ul className={compact ? "flex flex-wrap gap-1.5" : "grid gap-2 sm:grid-cols-2"}>
        {TEMPLATE_KEYS.map((k) => {
          const Icon = ICON[k];
          const t = copy.templates[k];
          return (
            <li key={k} className={compact ? "max-w-full" : "min-w-0"}>
              <button
                type="button" disabled={disabled} onClick={() => setOpen(k)}
                aria-haspopup="dialog"
                className={compact
                  ? "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[0.8rem] font-semibold text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-60"
                  : "flex min-h-14 w-full items-start gap-3 rounded-md border border-line bg-surface p-3 text-left transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-60"}
              >
                <Icon className={compact ? "size-4 shrink-0 text-amber" : "mt-0.5 size-5 shrink-0 text-amber"} aria-hidden="true" />
                {compact ? <span className="truncate">{t.name}</span> : (
                  <span className="min-w-0">
                    <span className="block font-semibold">{t.name}</span>
                    <span className="block text-small text-ink-2">{t.hint}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {open !== null && <BillSheet copy={copy} template={open} target={target} onClose={() => setOpen(null)} />}
    </>
  );
}
