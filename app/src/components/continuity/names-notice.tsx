"use client";
/** Where names are typed on the live network: says so while the server doesn't keep them (plan §18.3 S4). */
import { useEffect, useState } from "react";
import { continuity } from "@/content/continuity";
import { chainConfig } from "@/lib/chain/config";
import { useLocale } from "@/lib/i18n/client";
import { namesAreDurable } from "@/lib/estate-meta/storage-status";
import { Notice } from "@/components/ui/primitives";

export function NamesNotice({ className }: { className?: string }) {
  const t = continuity[useLocale()].names;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (chainConfig.dataMode !== "chain") return; // the demo keeps everything in this browser
    let alive = true;
    void namesAreDurable().then((durable) => { if (alive) setShow(durable === false); });
    return () => { alive = false; };
  }, []);
  if (!show) return null;
  return <Notice tone="accent" className={className}><p>{t.notDurable}</p></Notice>;
}
