"use client";
/**
 * Loads the "Ask for money" sheet only once someone asks to open it (`setIntent({ kind: "ask" })`), so pages that
 * never use it pay nothing for it. Mounted by the chat composer and the Claims screen.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useEstate } from "@/lib/hooks/estate";

const AskSheet = dynamic(() => import("./ask-sheet").then((m) => m.AskSheet), { ssr: false });

export function AskLauncher() {
  const { intent } = useEstate();
  const [wanted, setWanted] = useState(false);
  // The sheet consumes the intent itself once it has loaded.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (intent?.kind === "ask") setWanted(true); }, [intent]);
  return wanted ? <AskSheet /> : null;
}
