"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Base58 } from "@/lib/types";
import type { TreeService, TreeSnapshot } from "@/lib/tree/types";
import { useEstate } from "@/lib/hooks/estate";

/** The estate's Trust Tree from the service (mock or chain; lib/service/mock-tree.ts, chain-tree.ts). */
export function useTree(estate: Base58) {
  const { service, session } = useEstate();
  const viewer = session?.address ?? null;
  // Re-read when the persona changes (their own card, hidden state).
  const source: TreeService | null = useMemo(() => (service && viewer !== undefined ? service : null), [service, viewer]);
  const [state, setState] = useState<{ phase: "loading" | "ready" | "error"; snap: TreeSnapshot | null }>({ phase: "loading", snap: null });

  const load = useCallback(async () => {
    if (!source) return;
    try {
      const snap = await source.getTree(estate);
      setState({ phase: "ready", snap });
    } catch {
      setState((s) => ({ phase: s.snap ? "ready" : "error", snap: s.snap }));
    }
  }, [source, estate]);

  useEffect(() => {
    let live = true;
    if (!source) return;
    source.getTree(estate)
      .then((snap) => { if (live) setState({ phase: "ready", snap }); })
      .catch(() => { if (live) setState({ phase: "error", snap: null }); });
    return () => { live = false; };
  }, [source, estate]);

  return { ...state, source, reload: load };
}

/** Width of an element, kept up to date (0 until measured). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.current.observe(el);
  }, []);
  return [ref, width];
}

const query = "(min-width: 768px)";
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(query);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** True on screens of 768 px and wider (the map); false on phones (the list). */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
