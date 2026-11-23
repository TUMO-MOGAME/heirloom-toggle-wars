"use client";
/**
 * "Thabo left you a letter" (plan.md §16.9): for a family member, the first opened letter they have not read on this
 * device, with its occasion and "Read it" (→ /letters#ltr_…). Shown on /family, /estate and the chat home until the
 * letter is read here (seen ids only; no letter text is kept on the device). A CSS fade, none under reduced motion.
 */
import { ArrowRight, FileHeart } from "@/components/ui/icons";
import { ButtonLink } from "@/components/ui/primitives";
import { useEstate } from "@/lib/hooks/estate";
import { useLocalized } from "@/lib/i18n/client";
import { letters as english } from "@/content/letters";
import { browserStorage, seenIds } from "@/lib/letters/device";
import { useLettersView } from "./use-letters";
import { fill, letterWords, nameOf } from "./words";

export function LetterMoment({ variant = "card", className }: { variant?: "card" | "nudge"; className?: string }) {
  const copy = useLocalized(english, (t) => t.letters);
  const { role, snap } = useEstate();
  const view = useLettersView(role === "beneficiary");
  if (!view || !snap) return null;
  const seen = seenIds(browserStorage());
  const l = view.letters.filter((x) => x.state === "open" && !x.deleted && !seen.has(x.id)).sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0];
  if (!l) return null;
  const name = nameOf(snap, l.from);
  const occasion = letterWords(l, copy).occasion;
  const title = fill(variant === "nudge" ? copy.nudge.title : copy.moment.title, { name });
  return (
    <section aria-label={title} data-letter-moment className={`enter flex items-start gap-3 rounded-lg border border-line bg-surface p-4 shadow-card ${className ?? ""}`}>
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-amber"><FileHeart className="size-5" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {occasion && <p className="mt-0.5 text-small text-ink-2">{fill(copy.moment.body, { occasion })}</p>}
        <ButtonLink href={`/letters#${l.id}`} small className="mt-3">
          {variant === "nudge" ? copy.nudge.cta : copy.moment.cta}<ArrowRight className="size-4" aria-hidden="true" />
        </ButtonLink>
      </div>
    </section>
  );
}
