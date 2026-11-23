import type { Metadata } from "next";
import { screens } from "@/content/screens";
import { assets } from "@/content/assets";
import { HandoverScreen } from "@/components/assets/handover";

export const metadata: Metadata = { title: screens.handover.metaTitle, robots: { index: false, follow: false } };

/** /car/handover?asset=<asset address>: the asset is read in the browser, so the page itself stays static. */
export default function Page() {
  return <HandoverScreen copy={screens.handover} assets={assets} />;
}
