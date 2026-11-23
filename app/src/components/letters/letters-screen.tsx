"use client";
/**
 * /letters (plan.md §16.9). The heading is server-rendered; the letters themselves (list, editor, reading view) load
 * with next/dynamic after the first paint, so no letters code reaches any other page. The owner and the family
 * members named in the plan only; anyone else gets a short explanation.
 */
import dynamic from "next/dynamic";
import { Mail } from "@/components/ui/icons";
import { ButtonLink, EmptyState, Eyebrow, LoadingCards } from "@/components/ui/primitives";
import { Marked } from "@/components/ui/marked";
import { Gate } from "@/components/shell/gate";
import { useLocalized } from "@/lib/i18n/client";
import type { LettersCopy } from "@/content/letters";

const LettersView = dynamic(() => import("./letters-view"), { ssr: false, loading: () => <LoadingCards label="" /> });

export function LettersScreen({ copy: english }: { copy: LettersCopy }) {
  const copy = useLocalized(english, (t) => t.letters);
  return (
    <article aria-labelledby="letters-title" className="print-sheet mx-auto grid w-full max-w-3xl gap-5 *:min-w-0">
      <header className="min-w-0">
        <Eyebrow>{copy.eyebrow}</Eyebrow>
        <h1 id="letters-title" className="mt-1 text-h1"><Marked text={copy.title} /></h1>
        <p className="mt-2 text-lead text-ink-2">{copy.line}</p>
      </header>
      <Gate frame={<LoadingCards label={copy.loading} />}>
        {({ snap, role, session }) => ((role === "owner" || role === "beneficiary") && snap
          ? <LettersView copy={copy} snap={snap} role={role} viewer={session.address} />
          : (
            <EmptyState
              icon={<Mail className="size-6" aria-hidden="true" />}
              title={copy.noRole.title} body={copy.noRole.body}
              action={<ButtonLink href="/estate" variant="secondary">{copy.noRole.back}</ButtonLink>}
            />
          ))}
      </Gate>
    </article>
  );
}
