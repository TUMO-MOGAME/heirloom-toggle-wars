"use client";
import { useSyncExternalStore } from "react";

const never = () => () => undefined;

/** This site's origin in the browser; "" on the server (so prerendered HTML never holds a link to the wrong host). */
export function useOrigin(): string {
  return useSyncExternalStore(never, () => window.location.origin, () => "");
}

/** Whether the browser can open the system share sheet. */
export function useCanShare(): boolean {
  return useSyncExternalStore(never, () => typeof navigator.share === "function", () => false);
}
