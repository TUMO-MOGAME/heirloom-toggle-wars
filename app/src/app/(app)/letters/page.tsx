import type { Metadata } from "next";
import { letters } from "@/content/letters";
import { LettersScreen } from "@/components/letters/letters-screen";

export const metadata: Metadata = { title: letters.meta.title, robots: { index: false, follow: false } };

/** /letters: Letters for later (plan.md §16). Family only, noindex, disallowed in robots, not in the sitemap. */
export default function Page() {
  return <LettersScreen copy={letters} />;
}
