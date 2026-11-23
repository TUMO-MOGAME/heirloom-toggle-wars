import type { Metadata } from "next";
import { screens } from "@/content/screens";
import { unmark } from "@/lib/marked";
import { BillScreen } from "@/components/screens/bill";

export const metadata: Metadata = { title: unmark(screens.bill.title), robots: { index: false } };

export default function Page() {
  return <BillScreen copy={screens.bill} />;
}
