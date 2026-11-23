import type { Metadata } from "next";
import { tree } from "@/content/tree";
import { TreeScreen } from "@/components/tree/tree-screen";

export const metadata: Metadata = { title: tree.metaTitle, robots: { index: false, follow: false } };

/** /tree: the family's Trust Tree (plan.md §15). Family only, noindex, disallowed in robots, not in the sitemap. */
export default function Page() {
  return <TreeScreen copy={tree} />;
}
