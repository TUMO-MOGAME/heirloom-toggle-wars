"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { ExperimentEvent, Variant } from "./events";
import { planExperiment, type Experiment, type Snapshot } from "./flagsmith";

const SERVER: Snapshot = { status: "idle", variant: "control", locked: null };

/** When the screen locks its version (see usePlanVariant). */
export const shouldLock = (onScreen: boolean, revealed: boolean, snap: Snapshot) =>
  onScreen && !snap.locked && (snap.status === "ready" || snap.status === "off" || revealed);

/**
 * The plan builder's version (plan §4): "control" until Flagsmith is ready, and fixed for the visit once shown.
 * - `onScreen`: the plan builder's conversation screen is rendered. As soon as Flagsmith has settled (ready, or off
 *   after no key / the kill switch / the 1.5 s timeout), the version is locked and the exposure sent (once), whether or
 *   not the visitor has ticked consent yet, so visitors who leave before ticking are still counted.
 * - `revealed`: the suggested replies would show now (consent ticked). If Flagsmith has not settled by then, the
 *   visit is locked to control (and sends nothing), so control's replies never switch to blank in front of anyone.
 * Starts the SDK after first paint; the page never waits on it.
 */
export function usePlanVariant(onScreen: boolean, revealed: boolean, exp: Experiment = planExperiment): Variant {
  const snap = useSyncExternalStore(exp.subscribe, exp.getSnapshot, () => SERVER);
  useEffect(() => { exp.start(); }, [exp]);
  const variant: Variant = snap.locked ?? (snap.status === "ready" ? snap.variant : "control");
  const lock = shouldLock(onScreen, revealed, snap);
  useEffect(() => { if (lock) exp.markShown(variant); }, [lock, variant, exp]);
  return variant;
}

/** Sends one of the four plan events (no-op unless this visit was exposed). */
export const trackPlanEvent = (name: ExperimentEvent, value?: number) => planExperiment.track(name, value);
