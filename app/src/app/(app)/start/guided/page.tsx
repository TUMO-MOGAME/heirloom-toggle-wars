import type { Metadata } from "next";
import { guided } from "@/content/guided";
import { GuidedRun } from "@/components/guided/guided-run";

export const metadata: Metadata = { title: guided.page.metaTitle, description: guided.page.metaDescription, alternates: { canonical: "/start/guided" } };

/** The guided run (plan §22.2). Its code loads only on this page; /start links here. */
export default function Page() {
  return <GuidedRun />;
}
