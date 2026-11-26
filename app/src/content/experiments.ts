/**
 * The plan-builder experiment (plan §2 and §4): every name the app sends to Flagsmith, kept in one place. The
 * experiment adds no words to the screen (the `blank` version only hides the suggested replies), so this file holds
 * identifiers, not copy. Frozen by the pre-registration: renaming any of these after the `prereg` tag breaks the run.
 */
export const experiments = {
  /** The multivariate (string) flag under test. */
  flag: "plan_builder_examples",
  /**
   * The A/A check's flag (plan C11, Development only): two identical versions. It never changes the screen; the app
   * only sends its exposure alongside the real one, so Flagsmith can count the A/A experiment.
   */
  aaFlag: "aa_check",
  /** The boolean kill switch: off (or missing) means everyone sees `control` and nothing is sent. */
  killSwitch: "experiments_enabled",
  /** The versions the screen knows. Anything else Flagsmith returns is shown as `control`. */
  variants: ["control", "blank"] as const,
  /** The only event names the app may send (lib/experiments/events.ts types them). */
  events: ["plan_first_message", "plan_message", "plan_reviewed", "plan_signed"] as const,
  /** localStorage key of the random anonymous id (a UUID made on the device; clearing site data resets it). */
  storageKey: "heirloom.anon-id",
  /** How long the screen waits for Flagsmith before it settles on `control` for the visit. */
  timeoutMs: 1500,
} as const;
