import type { Metadata } from "next";
import { screens } from "@/content/screens";
import { unmark } from "@/lib/marked";
import { SendScreen } from "@/components/screens/send";

export const metadata: Metadata = { title: unmark(screens.send.title), robots: { index: false } };

export default function Page() {
  return <SendScreen copy={screens.send} />;
}
