"use client";
import { useCallback, useEffect, useState } from "react";
import { useEstate } from "@/lib/hooks/estate";
import type { LegacyStatus } from "@/lib/legacy/schema";

/** Strips the "Code: " prefix the mock uses, and turns fetch failures into a readable sentence. */
export function legacyError(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  const clean = m.replace(/^[A-Za-z]+: /, "").trim();
  return clean && !/failed to fetch|network/i.test(clean) ? clean : fallback;
}

/** Last status per estate + wallet, so entry cards can show it without asking the wallet to sign again. */
const cache = new Map<string, LegacyStatus>();

/**
 * Legacy status for whoever is acting, reloaded when the person or the estate's status changes.
 * `passive` (entry cards on shared screens): on the live network every status read is wallet-signed, which can
 * prompt for the PIN, so passive callers only use the cached status from a visit to /legacy and never sign.
 */
export function useLegacyStatus({ passive = false }: { passive?: boolean } = {}) {
  const { service, snap, session } = useEstate();
  const estate = snap?.estate.address ?? null;
  const estateStatus = snap?.estate.status ?? null;
  const who = session?.address ?? null;
  const key = `${estate}|${who}`;
  const [fetched, setFetched] = useState<{ key: string; status: LegacyStatus } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const quiet = passive && service?.mode === "chain";

  // Every answer is stored under the estate + wallet it was asked for, and only the one for the key on screen shows.
  // No answer is dropped for being "not the latest": a later read for the same key that was slow or never settled
  // left /legacy loading forever on devnet (22 Nov 2026).
  const store = useCallback((k: string, s: LegacyStatus) => { cache.set(k, s); setFetched({ key: k, status: s }); setFailed(null); }, []);
  const fail = useCallback((k: string, e: unknown) => setFailed({ key: k, message: legacyError(e, "Could not load the legacy voice.") }), []);

  const reload = useCallback(async () => {
    if (!service || !estate || !who) return;
    try { store(key, await service.legacyStatus(estate)); } catch (e) { fail(key, e); }
  }, [service, estate, who, key, store, fail]);

  useEffect(() => {
    if (!service || !estate || !who || quiet) return;
    service.legacyStatus(estate).then((s) => store(key, s)).catch((e: unknown) => fail(key, e));
  }, [service, estate, who, estateStatus, quiet, key, store, fail]);

  const status = fetched?.key === key ? fetched.status : cache.get(key) ?? null;
  const error = failed?.key === key ? failed.message : null;
  return { status, error, reload, estate, passive: quiet };
}
