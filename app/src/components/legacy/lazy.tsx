"use client";
/**
 * The Legacy Voice entry cards for shared screens, loaded after the page itself. They only appear once the
 * Legacy Book status has loaded, so nothing shows any later, but the Legacy Book code (companion, prompt,
 * schemas) stays out of the first page load.
 */
import dynamic from "next/dynamic";

export const LegacyEntry = dynamic(() => import("./legacy-entry").then((m) => m.LegacyEntry), { ssr: false });
export const MilestoneMoment = dynamic(() => import("./legacy-entry").then((m) => m.MilestoneMoment), { ssr: false });
