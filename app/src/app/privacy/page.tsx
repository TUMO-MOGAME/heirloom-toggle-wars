import type { Metadata } from "next";
import { privacy } from "@/content/legal";
import { site } from "@/content/site";
import { unmark } from "@/lib/marked";
import { LegalPage } from "@/components/site/legal-page";

export const metadata: Metadata = {
  title: unmark(privacy.title),
  description: privacy.intro,
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return <LegalPage site={site} doc={privacy} />;
}
