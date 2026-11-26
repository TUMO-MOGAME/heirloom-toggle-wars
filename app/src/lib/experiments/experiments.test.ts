import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { experiments } from "@/content/experiments";
import { createExperiment, type Sdk } from "./flagsmith";
import { isExperimentEvent, safeValue, toVariant, type ExperimentEvent } from "./events";
import { anonId, isAnonId, resetMemoryId } from "./identity";
import { shouldLock } from "./use-variant";

const ID = "6f1c2a4e-3b5d-4c7e-9f00-1a2b3c4d5e6f";

interface FakeFlags {
  killSwitch?: boolean;
  value?: unknown;
  enabled?: boolean;
  variant?: string;
  experiment?: { id: number; name: string; inExperiment: boolean };
}

/** A stand-in for the Flagsmith SDK: records every call, answers with the flags given. */
function fakeSdk(f: FakeFlags = {}, initDelayMs = 0) {
  const flags: Record<string, { enabled: boolean; value: unknown; variant?: string; experiment?: FakeFlags["experiment"] }> = {
    [experiments.killSwitch]: { enabled: f.killSwitch ?? true, value: null },
    [experiments.flag]: { enabled: f.enabled ?? true, value: "value" in f ? f.value : "blank", variant: f.variant, experiment: f.experiment },
  };
  const sdk = {
    init: vi.fn<(config: Record<string, unknown>) => Promise<void>>(() => new Promise<void>((r) => setTimeout(r, initDelayMs))),
    getValue: vi.fn((k: string) => flags[k]?.value ?? null),
    hasFeature: vi.fn((k: string) => !!flags[k]?.enabled),
    getAllFlags: vi.fn(() => flags),
    trackEvent: vi.fn(),
    trackExposureEvent: vi.fn(),
    flushEvents: vi.fn(() => Promise.resolve()),
  };
  return sdk;
}

function setup(f: FakeFlags = {}, o: { envKey?: string; initDelayMs?: number; timeoutMs?: number } = {}) {
  const sdk = fakeSdk(f, o.initDelayMs ?? 0);
  const load = vi.fn(() => Promise.resolve(sdk as unknown as Sdk));
  const doc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  doc.visibilityState = "visible";
  const win = new EventTarget();
  const fetchSpy = vi.fn();
  const exp = createExperiment({
    envKey: "envKey" in o ? o.envKey : "env-test-key",
    load,
    timeoutMs: o.timeoutMs ?? 1500,
    id: () => ID,
    schedule: (fn) => fn(),
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    fetch: fetchSpy,
  });
  return { exp, sdk, load, doc, win, fetchSpy };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const allSent = (sdk: ReturnType<typeof fakeSdk>) => sdk.trackEvent.mock.calls.length + sdk.trackExposureEvent.mock.calls.length;

afterEach(() => { vi.useRealTimers(); });

describe("no key", () => {
  it.each([undefined, ""])("shows control, never loads the SDK and sends nothing (key %j)", async (envKey) => {
    const { exp, load, sdk, fetchSpy } = setup({}, { envKey });
    exp.start();
    await settle();
    expect(exp.getSnapshot().status).toBe("off");
    expect(exp.current()).toBe("control");
    expect(exp.markShown(exp.current())).toBe("control");
    expect(exp.track("plan_first_message")).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(allSent(sdk)).toBe(0);
  });
});

describe("loading", () => {
  it("inits with the env key, events on, and the anonymous id as identity only", async () => {
    const { exp, sdk } = setup();
    exp.start();
    await settle();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    const config = sdk.init.mock.calls[0]![0];
    expect(config).toMatchObject({ environmentID: "env-test-key", enableEvents: true, identity: ID });
    expect(config).not.toHaveProperty("traits");
    expect(config).not.toHaveProperty("enableAnalytics");
    expect(exp.getSnapshot()).toMatchObject({ status: "ready", variant: "blank" });
    expect(exp.current()).toBe("blank");
  });

  it("starts once however often the screen mounts", async () => {
    const { exp, load } = setup();
    exp.start(); exp.start(); exp.start();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("falls back to control after the timeout, and stays there when Flagsmith answers late", async () => {
    vi.useFakeTimers();
    const { exp, sdk } = setup({ value: "blank" }, { initDelayMs: 5000, timeoutMs: 1500 });
    exp.start();
    await vi.advanceTimersByTimeAsync(1499);
    expect(exp.getSnapshot().status).toBe("loading");
    expect(exp.current()).toBe("control");
    await vi.advanceTimersByTimeAsync(1);
    expect(exp.getSnapshot().status).toBe("off");
    await vi.advanceTimersByTimeAsync(5000);
    expect(exp.getSnapshot().status).toBe("off");
    expect(exp.current()).toBe("control");
    exp.markShown(exp.current());
    expect(exp.track("plan_first_message")).toBe(false);
    expect(allSent(sdk)).toBe(0);
  });

  it("falls back to control when the SDK fails to load or init", async () => {
    const sdk = fakeSdk();
    sdk.init.mockImplementation(() => Promise.reject(new Error("network")));
    const exp = createExperiment({ envKey: "k", load: () => Promise.resolve(sdk as unknown as Sdk), id: () => ID, schedule: (fn) => fn(), doc: null, win: null });
    exp.start();
    await settle();
    expect(exp.getSnapshot().status).toBe("off");
    expect(exp.current()).toBe("control");

    const broken = createExperiment({ envKey: "k", load: () => Promise.reject(new Error("chunk")), id: () => ID, schedule: (fn) => fn(), doc: null, win: null });
    broken.start();
    await settle();
    expect(broken.current()).toBe("control");
  });

  it.each([["control", "control"], ["blank", "blank"], ["BLANK", "control"], ["examples", "control"], [null, "control"], [3, "control"]])(
    "maps Flagsmith's value %j to %j", async (value, want) => {
      const { exp } = setup({ value });
      exp.start();
      await settle();
      expect(exp.current()).toBe(want);
    },
  );

  it("shows control when the flag itself is disabled, and sends nothing", async () => {
    const { exp, sdk } = setup({ value: "blank", enabled: false });
    exp.start();
    await settle();
    expect(exp.current()).toBe("control");
    exp.markShown("control");
    exp.track("plan_message");
    expect(allSent(sdk)).toBe(0);
  });
});

describe("kill switch", () => {
  it("off: control for everyone and nothing is sent", async () => {
    const { exp, sdk } = setup({ killSwitch: false, value: "blank" });
    exp.start();
    await settle();
    expect(exp.getSnapshot().status).toBe("off");
    expect(exp.current()).toBe("control");
    exp.markShown(exp.current());
    for (const e of experiments.events) expect(exp.track(e)).toBe(false);
    expect(allSent(sdk)).toBe(0);
  });

  it("missing counts as off", async () => {
    const { exp, sdk } = setup({ value: "blank" });
    sdk.hasFeature.mockReturnValue(false);
    exp.start();
    await settle();
    expect(exp.current()).toBe("control");
  });
});

describe("exposure", () => {
  it("is not sent on load, only when the screen shows the value, and only once", async () => {
    const { exp, sdk } = setup({ value: "blank", variant: "blank", experiment: { id: 7, name: "Examples", inExperiment: true } });
    exp.start();
    await settle();
    expect(sdk.trackExposureEvent).not.toHaveBeenCalled();
    exp.markShown(exp.current());
    exp.markShown(exp.current());
    exp.markShown("control");
    expect(sdk.trackExposureEvent).toHaveBeenCalledTimes(1);
    expect(sdk.trackExposureEvent).toHaveBeenCalledWith(experiments.flag, { value: "blank", metadata: { experiment_id: 7 } });
  });

  it("is sent with the SDK's own payload shape when no experiment metadata came back", async () => {
    const { exp, sdk } = setup({ value: "control" });
    exp.start();
    await settle();
    exp.markShown(exp.current());
    expect(sdk.trackExposureEvent).toHaveBeenCalledWith(experiments.flag, { value: null });
  });

  it("is not sent for an identity a running experiment left out (as getExperimentFlag)", async () => {
    const { exp, sdk } = setup({ value: "blank", experiment: { id: 7, name: "Examples", inExperiment: false } });
    exp.start();
    await settle();
    exp.markShown(exp.current());
    expect(sdk.trackExposureEvent).not.toHaveBeenCalled();
    expect(exp.track("plan_first_message")).toBe(false);
  });

  it("is not sent when the screen showed control before Flagsmith answered", async () => {
    vi.useFakeTimers();
    const { exp, sdk } = setup({ value: "blank" }, { initDelayMs: 500 });
    exp.start();
    exp.markShown(exp.current()); // reply area shown while still loading
    await vi.advanceTimersByTimeAsync(600);
    expect(exp.getSnapshot().status).toBe("ready");
    expect(exp.current()).toBe("control");
    expect(sdk.trackExposureEvent).not.toHaveBeenCalled();
    expect(exp.track("plan_message")).toBe(false);
  });
});

describe("variant stability", () => {
  it("never changes in the visit once shown", async () => {
    vi.useFakeTimers();
    const { exp } = setup({ value: "blank" }, { initDelayMs: 500 });
    exp.start();
    expect(exp.markShown(exp.current())).toBe("control");
    await vi.advanceTimersByTimeAsync(600);
    expect(exp.current()).toBe("control");
    expect(exp.markShown("blank")).toBe("control");
    expect(exp.current()).toBe("control");
  });

  it("keeps blank once shown as blank", async () => {
    const { exp } = setup({ value: "blank" });
    exp.start();
    await settle();
    exp.markShown(exp.current());
    expect(exp.markShown("control")).toBe("blank");
    expect(exp.current()).toBe("blank");
    expect(exp.getSnapshot().locked).toBe("blank");
  });

  it("tells subscribers when the version settles", async () => {
    const { exp } = setup({ value: "blank" });
    const seen: string[] = [];
    exp.subscribe(() => seen.push(exp.current()));
    exp.start();
    await settle();
    expect(seen.at(-1)).toBe("blank");
  });
});

describe("events", () => {
  async function exposed(f: FakeFlags = { value: "blank" }) {
    const s = setup(f);
    s.exp.start();
    await settle();
    s.exp.markShown(s.exp.current());
    return s;
  }

  it("only the four allowed names exist", () => {
    expect([...experiments.events].sort()).toEqual(["plan_first_message", "plan_message", "plan_reviewed", "plan_signed"]);
    for (const e of experiments.events) expect(isExperimentEvent(e)).toBe(true);
    for (const bad of ["plan_first_messages", "$flag_exposure", "", "Plan_message", null, 1]) expect(isExperimentEvent(bad)).toBe(false);
  });

  it("refuses any other name at run time", async () => {
    const { exp, sdk } = await exposed();
    expect(exp.track("plan_started" as ExperimentEvent)).toBe(false);
    expect(exp.track("$flag_exposure" as ExperimentEvent)).toBe(false);
    expect(sdk.trackEvent).not.toHaveBeenCalled();
  });

  it("are not sent before the exposure", async () => {
    const { exp, sdk } = setup({ value: "blank" });
    exp.start();
    await settle();
    expect(exp.track("plan_first_message")).toBe(false);
    expect(sdk.trackEvent).not.toHaveBeenCalled();
  });

  it("count occurrences once per visit, and every plan_message", async () => {
    const { exp, sdk } = await exposed();
    exp.track("plan_first_message"); exp.track("plan_first_message");
    exp.track("plan_message"); exp.track("plan_message"); exp.track("plan_message");
    exp.track("plan_reviewed"); exp.track("plan_reviewed");
    exp.track("plan_signed");
    const names = sdk.trackEvent.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["plan_first_message", "plan_message", "plan_message", "plan_message", "plan_reviewed", "plan_signed"]);
  });

  it("carry no text or personal data: only the name and, at most, a number", async () => {
    const { exp, sdk } = await exposed({ value: "blank", variant: "blank", experiment: { id: 3, name: "Examples", inExperiment: true } });
    exp.track("plan_first_message");
    exp.track("plan_message", 2);
    exp.track("plan_reviewed", "Lerato's books" as unknown as number);
    exp.track("plan_signed", Number.NaN);
    for (const call of sdk.trackEvent.mock.calls as unknown[][]) {
      expect(isExperimentEvent(call[0])).toBe(true);
      expect(call.length).toBeLessThanOrEqual(2);
      if (call.length === 2) {
        expect(Object.keys(call[1] as object)).toEqual(["value"]);
        expect(typeof (call[1] as { value: unknown }).value).toBe("number");
      }
    }
    expect(sdk.trackEvent).toHaveBeenCalledWith("plan_message", { value: 2 });
    // Nothing anywhere in what was sent or set up carries more than the id, names, the variant key and numbers.
    const everything = JSON.stringify([sdk.init.mock.calls, sdk.trackEvent.mock.calls, sdk.trackExposureEvent.mock.calls]);
    expect(everything).not.toMatch(/Lerato|books|@|wallet|email|traits/i);
    const strings = everything.match(/"[^"]*"/g)!.map((s) => s.slice(1, -1));
    const allowed = new Set<string>([ID, "env-test-key", "environmentID", "enableEvents", "identity", "fetch", "value", "metadata", "experiment_id", experiments.flag, ...experiments.events, ...experiments.variants]);
    expect(strings.filter((s) => !allowed.has(s))).toEqual([]);
  });

  it("flush when the tab hides or the page is left", async () => {
    const { sdk, doc, win } = await exposed();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(sdk.flushEvents).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("pagehide"));
    expect(sdk.flushEvents).toHaveBeenCalledTimes(2);
  });

  it("numbers only", () => {
    expect(safeValue(3)).toBe(3);
    expect(safeValue("3")).toBeUndefined();
    expect(safeValue(Infinity)).toBeUndefined();
    expect(toVariant(undefined)).toBe("control");
  });
});

describe("anonymous id", () => {
  afterEach(() => resetMemoryId());
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it("is a random UUID kept on the device, the same on every read", () => {
    const s = store();
    const a = anonId(s);
    expect(isAnonId(a)).toBe(true);
    expect(s.m.get(experiments.storageKey)).toBe(a);
    expect(anonId(s)).toBe(a);
    expect(anonId(store())).not.toBe(anonId(store()) === a ? "" : a); // a fresh device gets a new id
  });

  it("replaces anything in storage that is not a UUID", () => {
    const s = store();
    s.m.set(experiments.storageKey, "lerato@example.com");
    const a = anonId(s);
    expect(isAnonId(a)).toBe(true);
    expect(s.m.get(experiments.storageKey)).toBe(a);
  });

  it("falls back to an in-memory id, stable for the visit, when storage is blocked", () => {
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const a = anonId(blocked);
    expect(isAnonId(a)).toBe(true);
    expect(anonId(blocked)).toBe(a);
    expect(anonId(null)).toBe(a);
  });
});

describe("/will wiring", () => {
  const src = readFileSync(fileURLToPath(new URL("../../components/screens/will.tsx", import.meta.url)), "utf8");

  it("sends only allowed event names", () => {
    const names = [...src.matchAll(/trackPlanEvent\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(experiments.events));
    expect(src).not.toMatch(/trackPlanEvent\(\s*[^"\s]/); // never a computed name
    expect(src).not.toMatch(/trackPlanEvent\([^)]*,/); // never a value from the screen (text, names, amounts)
  });

  it("blank hides only the suggested replies; the composer stays", () => {
    expect(src).toMatch(/variant !== "blank" && <Chips /);
    expect(src.match(/variant ===? "blank"|variant !== "blank"/g)).toHaveLength(1);
    expect(src).toMatch(/<Composer onSend=\{send\} disabled=\{pending\} copy=\{copy\.composer\} \/>/);
  });
});

describe("when the screen locks its version", () => {
  const snap = (status: "idle" | "loading" | "ready" | "off", locked: "control" | "blank" | null = null) => ({ status, variant: "blank" as const, locked });

  it("locks (and exposes) as soon as the conversation screen shows a settled value, before consent", () => {
    expect(shouldLock(true, false, snap("ready"))).toBe(true);
    expect(shouldLock(true, false, snap("off"))).toBe(true);
  });

  it("waits while loading, unless the replies are revealed first (then control is locked)", () => {
    expect(shouldLock(true, false, snap("loading"))).toBe(false);
    expect(shouldLock(true, false, snap("idle"))).toBe(false);
    expect(shouldLock(true, true, snap("loading"))).toBe(true);
  });

  it("never off the conversation screen, and never twice", () => {
    expect(shouldLock(false, true, snap("ready"))).toBe(false);
    expect(shouldLock(true, true, snap("ready", "blank"))).toBe(false);
  });

  it("exposes a visitor who never ticks consent", async () => {
    const { exp, sdk } = setup({ value: "blank" });
    exp.start();
    await settle();
    if (shouldLock(true, false, exp.getSnapshot())) exp.markShown(exp.current());
    expect(sdk.trackExposureEvent).toHaveBeenCalledTimes(1);
  });
});
