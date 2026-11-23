"use client";
import { useEffect, useState } from "react";
import { useEstate } from "@/lib/hooks/estate";
import type { LettersView } from "@/lib/letters/types";

/**
 * The signed-in person's letters (owner: theirs; family member: the open ones they may read), re-read when the estate
 * changes in a way that can open a letter (its status, a payment under a rule). Null while loading or when the person
 * has no letters to see (a buyer, a trusted person).
 */
export function useLettersView(enabled: boolean): LettersView | null {
  const { service, snap, session } = useEstate();
  const [view, setView] = useState<LettersView | null>(null);
  const estate = snap?.estate.address ?? null;
  const status = snap?.estate.status;
  const spent = snap?.rules.map((r) => `${r.address}:${r.spentTotal}`).join(",") ?? "";
  const viewer = session?.address ?? null;
  useEffect(() => {
    if (!enabled || !service || !estate || !viewer) return;
    let live = true;
    // A background read (the /will card, the "a letter for you" notices): never asks for a PIN.
    service.listLetters(estate, { quiet: true }).then((v) => { if (live) setView(v); }).catch(() => { if (live) setView(null); });
    return () => { live = false; };
  }, [enabled, service, estate, status, spent, viewer]);
  return enabled ? view : null;
}
