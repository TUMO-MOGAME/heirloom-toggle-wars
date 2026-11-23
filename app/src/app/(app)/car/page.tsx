import type { Metadata } from "next";
import { screens } from "@/content/screens";
import { assets } from "@/content/assets";
import { CarScreen } from "@/components/screens/car";

export const metadata: Metadata = { title: assets.meta.title, robots: { index: false } };

export default function Page() {
  return <CarScreen copy={screens.car} assets={assets} />;
}
