"use client";
/**
 * Android back button (and back gesture) closes an open sheet, dialog or drawer before it navigates.
 *
 * - Chromium 120+ (Chrome and Samsung Internet on Android, and a Trusted Web Activity in the store app) already
 *   sends the back button to the top modal <dialog> as a close request: the dialog's `cancel` event, which every
 *   Heirloom dialog handles. Nothing to add there (`CloseWatcher` in window).
 * - Other browsers (Firefox for Android, older WebViews): while the dialog is open we add one same-URL history
 *   entry; back pops it and we close the dialog instead of leaving the page.
 *
 * Closed from the page instead (close button, Esc, a choice, a link): we must NOT call history.back() then, because
 * a navigation started by the same tap may still be loading and Next.js drops an in-flight navigation when a
 * popstate arrives. So the entry is only marked dead (replaceState, synchronous), and dead entries are skipped later:
 *  - arriving on a dead entry (going back from a later page) goes back once more;
 *  - leaving a dead entry we were still on (no navigation since) lands on the same page, so that press is repeated.
 */
import { useEffect, useRef } from "react";

const KEY = "__heirloomOverlay";
const DEAD = "dead";
type State = Record<string, unknown> | null;
const state = () => window.history.state as State;

/** href of the current entry while it is a dead overlay entry we are still on (cleared by any push). */
let deadHere: string | null = null;
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  // Any push (a navigation, or another overlay) moves us off the dead entry.
  const push = window.history.pushState;
  window.history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    deadHere = null;
    return push.apply(this, args);
  };
  window.addEventListener("popstate", () => {
    if (state()?.[KEY] === DEAD) { deadHere = null; window.history.back(); return; } // skip a dead entry
    const left = deadHere;
    deadHere = null;
    if (left && left === window.location.href) window.history.back(); // that press changed nothing visible
  });
}

export function useBackClose(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    if (!open || typeof window === "undefined" || "CloseWatcher" in window) return;
    install();
    const token = Math.random().toString(36).slice(2);
    window.history.pushState({ ...(state() ?? {}), [KEY]: token }, "");
    let poppedByBack = false;
    const onPop = () => {
      if (state()?.[KEY] === token) return;
      poppedByBack = true;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (poppedByBack || state()?.[KEY] !== token) return;
      window.history.replaceState({ ...(state() ?? {}), [KEY]: DEAD }, "");
      deadHere = window.location.href;
    };
  }, [open]);
}
