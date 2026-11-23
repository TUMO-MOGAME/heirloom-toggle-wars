import type { Metadata } from "next";
import { screens } from "@/content/screens";
import { StatementScreen } from "@/components/screens/statement";

export const metadata: Metadata = { title: screens.statement.metaTitle, robots: { index: false, follow: false } };

/** /statement?month=YYYY-MM: the month is read in the browser, so the page itself stays static. */
export default function Page() {
  return <StatementScreen copy={screens.statement} />;
}
