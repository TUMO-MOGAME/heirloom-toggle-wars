import type { IFlagsmith, IInitConfig } from "@flagsmith/flagsmith/types";
import { experiments } from "@/content/experiments";
import { ONCE_PER_VISIT, isExperimentEvent, safeValue, toVariant, type ExperimentEvent, type Variant } from "./events";
import { anonId } from "./identity";

/**
 * The plan-builder experiment's link to Flagsmith (plan §4). The rules it keeps:
 * - Never blocks the page: the SDK is imported only after first paint, and only on the plan builder. With no
 *   environment key, a load error, the kill switch off, or no answer within 1.5 s, the screen shows `control` and
 *   nothing is sent (no key means no network at all).
 * - The version is locked the first time the screen shows it, and never changes in that visit.
 * - Exposure is sent once, when the screen shows Flagsmith's value; events are sent only after that exposure, only
 *   with the names in events.ts, and carry nothing but the anonymous id (set at init) and an optional number.
 */

export type Sdk = Pick<IFlagsmith, "init" | "getValue" | "hasFeature" | "getAllFlags" | "trackEvent" | "trackExposureEvent" | "flushEvents">;
export type Status = "idle" | "loading" | "ready" | "off";

export interface Snapshot {
  status: Status;
  /** Flagsmith's version for this visitor once ready, else control. */
  variant: Variant;
  /** The version the screen showed first; fixed for the visit. */
  locked: Variant | null;
}

export interface ExperimentOptions {
  envKey: string | undefined;
  load: () => Promise<Sdk>;
  timeoutMs?: number;
  id?: () => string;
  /** Runs the loader after first paint. */
  schedule?: (fn: () => void) => void;
  /** Where the flush-on-leave listeners go (document: visibilitychange, window: pagehide). */
  doc?: Pick<Document, "addEventListener" | "visibilityState"> | null;
  win?: Pick<Window, "addEventListener"> | null;
  fetch?: IInitConfig["fetch"];
}

function afterFirstPaint(fn: () => void) {
  if (typeof window === "undefined") return;
  const later = () => setTimeout(fn, 0);
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(later);
  else later();
}

/** Lets a batch sent as the tab closes still arrive (flush on leave, plan §5a). */
const keepaliveFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, init?.method === "POST" ? { ...init, keepalive: true } : init);

export function createExperiment(opts: ExperimentOptions) {
  const timeoutMs = opts.timeoutMs ?? experiments.timeoutMs;
  let snap: Snapshot = { status: "idle", variant: "control", locked: null };
  let sdk: Sdk | null = null;
  // Exposure details captured at ready: whether this identity is in the experiment, and the SDK's own exposure payload.
  let enrolled = false;
  let exposureValue: string | null = null;
  let experimentId: number | null = null;
  let exposed = false;
  const sent = new Set<ExperimentEvent>();
  const listeners = new Set<() => void>();

  const set = (next: Partial<Snapshot>) => {
    snap = { ...snap, ...next };
    listeners.forEach((l) => l());
  };

  const flush = () => {
    if (!sdk || !exposed) return;
    sdk.flushEvents().catch(() => undefined);
  };

  const watchLeave = () => {
    const doc = opts.doc === undefined ? (typeof document !== "undefined" ? document : null) : opts.doc;
    const win = opts.win === undefined ? (typeof window !== "undefined" ? window : null) : opts.win;
    doc?.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") flush(); });
    win?.addEventListener("pagehide", flush);
  };

  const run = async () => {
    const timer = setTimeout(() => { if (snap.status === "loading") set({ status: "off" }); }, timeoutMs);
    try {
      const client = await opts.load();
      if (snap.status !== "loading") return;
      await client.init({
        environmentID: opts.envKey,
        enableEvents: true,
        // The same as identify(anonId) before the first fetch, in one request instead of two.
        identity: (opts.id ?? anonId)(),
        fetch: opts.fetch ?? keepaliveFetch,
      });
      if (snap.status !== "loading") return; // timed out meanwhile: control for this visit
      if (!client.hasFeature(experiments.killSwitch, { skipAnalytics: true })) { set({ status: "off" }); return; }
      const flag = client.getAllFlags()[experiments.flag];
      const variant = flag?.enabled ? toVariant(client.getValue(experiments.flag, { skipAnalytics: true })) : "control";
      // As the SDK's own getExperimentFlag: no exposure for an identity a running experiment left out.
      enrolled = !!flag?.enabled && (!flag.experiment || flag.experiment.inExperiment);
      exposureValue = flag?.variant ?? null;
      experimentId = flag?.experiment?.id ?? null;
      sdk = client;
      watchLeave();
      set({ status: "ready", variant });
    } catch {
      if (snap.status === "loading") set({ status: "off" });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /** Starts loading after first paint (once). With no key it settles on control straight away, with no network. */
    start() {
      if (snap.status !== "idle") return;
      if (!opts.envKey) { set({ status: "off" }); return; }
      set({ status: "loading" });
      (opts.schedule ?? afterFirstPaint)(() => void run());
    },
    getSnapshot: () => snap,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    /** What the screen shows: the locked version, else Flagsmith's once ready, else control. */
    current: (): Variant => snap.locked ?? (snap.status === "ready" ? snap.variant : "control"),
    /**
     * The screen now shows `rendered`: lock it for the visit and, if it is Flagsmith's own value, send the exposure
     * (once). A version shown before Flagsmith answered is control, and that visit sends nothing.
     */
    markShown(rendered: Variant): Variant {
      if (snap.locked) return snap.locked;
      const fromFlagsmith = snap.status === "ready" && rendered === snap.variant;
      if (fromFlagsmith && enrolled && sdk && !exposed) {
        sdk.trackExposureEvent(experiments.flag, {
          value: exposureValue,
          ...(experimentId !== null ? { metadata: { experiment_id: experimentId } } : {}),
        });
        exposed = true;
      }
      set({ locked: rendered });
      return rendered;
    },
    /** Sends one allowed event, only for a visit that was exposed. Returns whether it was sent. */
    track(name: ExperimentEvent, value?: number): boolean {
      if (!isExperimentEvent(name) || !sdk || !exposed) return false;
      if (ONCE_PER_VISIT.has(name)) {
        if (sent.has(name)) return false;
        sent.add(name);
      }
      const v = safeValue(value);
      if (v === undefined) sdk.trackEvent(name);
      else sdk.trackEvent(name, { value: v });
      return true;
    },
    /** Sends what is buffered now (also done on tab hide and page leave). */
    flush,
  };
}

export type Experiment = ReturnType<typeof createExperiment>;

/** The app's one experiment client. NEXT_PUBLIC_ so the client-side environment key is inlined at build. */
export const planExperiment = createExperiment({
  envKey: process.env.NEXT_PUBLIC_FLAGSMITH_ENVIRONMENT_KEY,
  load: () => import("@flagsmith/flagsmith").then((m) => m.createFlagsmithInstance()),
});
