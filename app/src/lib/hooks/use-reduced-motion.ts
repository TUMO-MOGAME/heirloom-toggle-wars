"use client";
import { useRef, useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * The visitor's reduced-motion setting, without the motion library (so the pages people open first never load it).
 * False during server rendering and hydration, like motion's own hook.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
}

/**
 * True once `value` differs from what it was when the component mounted: lets a CSS one-shot animation play on a
 * change (a dot filling) but not on the first render (motion's `initial={false}`).
 */
export function useChangedSinceMount<T>(value: T): boolean {
  const first = useRef(value);
  // eslint-disable-next-line react-hooks/refs -- read-only: the value from the first render never changes
  return !Object.is(first.current, value);
}
