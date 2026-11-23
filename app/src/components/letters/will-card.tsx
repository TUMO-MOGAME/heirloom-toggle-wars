"use client";
/** The owner's "Letters for later" card on /will (plan.md §16.9): how many letters, how many open with a gift. */
import { ArrowRight, FileHeart } from "@/components/ui/icons";
import { ButtonLink, Card } from "@/components/ui/primitives";
import { useEstate } from "@/lib/hooks/estate";
import { useLocalized } from "@/lib/i18n/client";
import { letters as english } from "@/content/letters";
import { useLettersView } from "./use-letters";
import { fill } from "./words";

export function WillLettersCard({ className }: { className?: string }) {
  const copy = useLocalized(english, (t) => t.letters);
  const { role } = useEstate();
  const view = useLettersView(role === "owner");
  if (!view) return null;
  const live = view.letters.filter((l) => !l.deleted);
  const gifts = live.filter((l) => l.opens.kind === "payment" || l.opens.kind === "send").length;
  return (
    <Card className={className}>
      <h2 className="flex items-center gap-2 text-h3"><FileHeart className="size-5 text-amber" aria-hidden="true" />{copy.willCard.title}</h2>
      <p className="mt-1 text-small text-ink-2">{live.length ? fill(copy.willCard.body, { count: live.length, gifts }) : copy.willCard.empty}</p>
      <ButtonLink href="/letters" variant="secondary" small className="mt-3">{copy.willCard.cta}<ArrowRight className="size-4" aria-hidden="true" /></ButtonLink>
    </Card>
  );
}
