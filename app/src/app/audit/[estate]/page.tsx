import type { Metadata } from "next";
import { Suspense } from "react";
import { screens } from "@/content/screens";
import { common } from "@/content/common";
import { assistant } from "@/content/assistant";
import { pay } from "@/content/pay";
import { guardians } from "@/content/guardians";
import { site } from "@/content/site";
import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { LoadingCards } from "@/components/ui/primitives";
import { disputes } from "@/content/disputes";
import { AuditScreen } from "@/components/audit/audit-screen";

/** A shared link to one family's record: never indexed or followed by search engines. */
export const metadata: Metadata = {
  title: screens.audit.metaTitle,
  description: screens.audit.metaDescription,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  alternates: { canonical: null },
  referrer: "no-referrer",
};

async function Record({ params }: { params: Promise<{ estate: string }> }) {
  const { estate } = await params;
  return <AuditScreen address={decodeURIComponent(estate)} copy={screens.audit} shell={{ common, assistant, pay, guardians, disputes, siteName: site.name }} />;
}

export default function Page({ params }: PageProps<"/audit/[estate]">) {
  return (
    <>
      <SiteHeader site={site} minimal />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-8 outline-none md:py-12">
        <Suspense fallback={<LoadingCards label={screens.audit.loading} />}>
          <Record params={params} />
        </Suspense>
      </main>
      <SiteFooter site={site} />
    </>
  );
}
