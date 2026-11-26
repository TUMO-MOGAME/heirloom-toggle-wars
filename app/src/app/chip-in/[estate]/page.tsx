import type { Metadata } from "next";
import { Suspense } from "react";
import { site } from "@/content/site";
import { chipin } from "@/content/chipin";
import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { LoadingCards } from "@/components/ui/primitives";
import { ChipInPage } from "@/components/chipin/chip-in-page";

/** A family's shared chip-in link: never indexed or followed by search engines. Blinks reach it via /actions.json. */
export const metadata: Metadata = {
  title: chipin.page.metaTitle,
  description: chipin.page.metaDescription,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  alternates: { canonical: null },
  referrer: "no-referrer",
};

async function Body({ params }: { params: Promise<{ estate: string }> }) {
  const { estate } = await params;
  return <ChipInPage estate={decodeURIComponent(estate)} />;
}

export default function Page({ params }: { params: Promise<{ estate: string }> }) {
  return (
    <>
      <SiteHeader site={site} minimal />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-8 outline-none md:py-12">
        <Suspense fallback={<LoadingCards label={chipin.page.metaTitle} />}>
          <Body params={params} />
        </Suspense>
      </main>
      <SiteFooter site={site} />
    </>
  );
}
