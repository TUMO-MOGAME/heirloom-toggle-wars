import type { Metadata } from "next";
import { tryDemo } from "@/content/try";
import { TryRedirect } from "./try-redirect";

// A shared link that resets the demo, not a page of its own: kept out of search (the plan builder is /will).
export const metadata: Metadata = { title: tryDemo.metaTitle, description: tryDemo.metaDescription, robots: { index: false } };

/** /try (plan §4, C5): the demo as a new owner with no plan, straight on the plan builder. */
export default function Page() {
  return <TryRedirect copy={tryDemo} />;
}
