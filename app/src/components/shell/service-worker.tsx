"use client";
import { useEffect } from "react";

/** Registers the service worker (production only, so dev never serves stale files), after the page has settled. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    // Registered a few seconds after load, once the page is idle: installing it fetches the offline shell, which
    // must not compete with the first screen on a slow connection.
    let timer: number | undefined;
    let idle: number | undefined;
    const register = () => { navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined); };
    const later = () => {
      timer = window.setTimeout(() => {
        if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(register, { timeout: 5000 });
        else register();
      }, 4000);
    };
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
    return () => {
      window.removeEventListener("load", later);
      if (timer !== undefined) window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, []);
  return null;
}
