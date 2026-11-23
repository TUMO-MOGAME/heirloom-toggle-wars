"use client";
/**
 * Appearance choice (dark, light or system), shared by the sidebar toggle and the persona sheet. Remembered on this device.
 *
 * Dark is the default: a first visit (nothing saved) gets dark whatever the device prefers. The CSS makes the bare
 * page dark (`:root` holds the dark tokens), so the server HTML, a page without JavaScript and the first paint are all
 * dark with no script at all. A saved choice is put on <html data-theme> before first paint by the inline script in
 * app/layout.tsx (PREPAINT): "light" is light, "system" follows the device through `prefers-color-scheme`, "dark"
 * is the default made explicit. So the wrong theme never flashes.
 */
import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
export const DEFAULT_THEME: Theme = "dark";
export const THEME_KEY = "heirloom.theme";
const EVENT = "heirloom:theme";
/** The page colour per theme, for the browser's theme-color (address bar / status bar). Matches --bg. */
const PAGE = { light: "#ffffff", dark: "#000000" } as const;

function read(): Theme {
  try {
    const t = window.localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" || t === "system" ? t : DEFAULT_THEME;
  } catch { return DEFAULT_THEME; }
}

const prefersDark = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Whether a choice shows dark right now ("system" asks the device). */
export function resolveDark(t: Theme, deviceDark: boolean): boolean {
  return t === "dark" || (t === "system" && deviceDark);
}

function subscribe(cb: () => void): () => void {
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  mq?.addEventListener("change", cb);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener("storage", cb); mq?.removeEventListener("change", cb); };
}

/** Applies a theme choice to the page, and keeps the browser's theme-color in step. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  const color = resolveDark(t, prefersDark()) ? PAGE.dark : PAGE.light;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
}

export function setTheme(t: Theme): void {
  applyTheme(t);
  try { window.localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The saved choice (dark when nothing is saved) and whether the page is dark right now. Dark during server rendering. */
export function useTheme(): { theme: Theme; dark: boolean } {
  const snapshot = useSyncExternalStore(subscribe, () => `${read()}|${prefersDark() ? 1 : 0}`, () => `${DEFAULT_THEME}|1`);
  const [theme, sys] = snapshot.split("|") as [Theme, string];
  return { theme, dark: resolveDark(theme, sys === "1") };
}
