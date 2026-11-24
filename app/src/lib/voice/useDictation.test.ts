/**
 * Voice typing's state machine (useDictation.ts): idle → checking → recording → transcribing → idle, with the words
 * handed back (never sent), the microphone released every time, a one-minute stop, and graceful "unavailable".
 */
import { describe, expect, it, vi } from "vitest";
import { createDictation, type DictationDeps, type DictationSnapshot, type RecorderLike } from "./useDictation";

class FakeRecorder implements RecorderLike {
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(private bytes = 500) {}
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    if (this.bytes) this.ondataavailable?.({ data: new Blob([new Uint8Array(this.bytes)]) });
    this.onstop?.();
  }
}

function setup(opts: { available?: boolean; reply?: () => Response; bytes?: number; blocked?: boolean; noMedia?: boolean } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const recorders: FakeRecorder[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const posts: FormData[] = [];
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (!init || init.method === "GET") return Response.json({ available: opts.available ?? true });
    posts.push(init.body as FormData);
    return opts.reply ? opts.reply() : Response.json({ text: "Give the books to Thabo", language: "en" });
  });
  const deps: DictationDeps = {
    getUserMedia: opts.noMedia ? undefined : vi.fn(async () => { if (opts.blocked) throw new Error("NotAllowedError"); return stream; }),
    createRecorder: opts.noMedia ? undefined : () => { const r = new FakeRecorder(opts.bytes ?? 500); recorders.push(r); return r; },
    pickMime: () => "audio/webm;codecs=opus",
    fetch: fetchFn as unknown as typeof fetch,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { (t as { cleared: boolean }).cleared = true; },
  };
  const states: DictationSnapshot["state"][] = [];
  const d = createDictation(deps, (s) => states.push(s.state));
  const texts: string[] = [];
  const onText = (t: string) => texts.push(t);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { d, deps, track, recorders, timers, posts, fetchFn, states, texts, onText, settle };
}

describe("createDictation", () => {
  it("records on the first tap, transcribes on the second, hands the words back and releases the microphone", async () => {
    const t = setup();
    await t.d.toggle("zu", t.onText);
    expect(t.d.get().state).toBe("recording");
    expect(t.track.stop).not.toHaveBeenCalled();
    await t.d.toggle("zu", t.onText);
    await t.settle();
    expect(t.states).toEqual(["checking", "recording", "transcribing", "idle"]);
    expect(t.texts).toEqual(["Give the books to Thabo"]);
    expect(t.track.stop).toHaveBeenCalled();
    expect(t.posts[0].get("language")).toBe("zu");
    expect((t.posts[0].get("audio") as Blob).type).toBe("audio/webm");
    expect(t.timers[0].cleared).toBe(true);
  });

  it("stops by itself after a minute", async () => {
    const t = setup();
    await t.d.toggle("en", t.onText);
    expect(t.timers[0].ms).toBe(60_000);
    t.timers[0].fn();
    await t.settle();
    expect(t.texts).toHaveLength(1);
    expect(t.track.stop).toHaveBeenCalled();
  });

  it("is 'unavailable' without asking for the microphone when the service isn't set up", async () => {
    const t = setup({ available: false });
    await t.d.toggle("en", t.onText);
    expect(t.d.get().state).toBe("unavailable");
    expect(t.deps.getUserMedia).not.toHaveBeenCalled();
    await t.d.toggle("en", t.onText); // asks once per page
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("turns 'unavailable' if the server says so after recording", async () => {
    const t = setup({ reply: () => Response.json({ error: "unavailable", code: "unavailable" }, { status: 503 }) });
    await t.d.toggle("en", t.onText);
    await t.d.toggle("en", t.onText);
    await t.settle();
    expect(t.d.get().state).toBe("unavailable");
    expect(t.texts).toEqual([]);
  });

  it("explains a blocked microphone, a missing recorder, silence, limits and failures", async () => {
    const blocked = setup({ blocked: true });
    await blocked.d.toggle("en", blocked.onText);
    expect(blocked.d.get()).toMatchObject({ state: "error", error: "blocked" });

    const none = setup({ noMedia: true });
    await none.d.toggle("en", none.onText);
    expect(none.d.get()).toMatchObject({ state: "error", error: "unsupported" });

    const silent = setup({ bytes: 0 });
    await silent.d.toggle("en", silent.onText);
    await silent.d.toggle("en", silent.onText);
    expect(silent.d.get()).toMatchObject({ state: "error", error: "empty" });
    expect(silent.posts).toHaveLength(0);

    const nothing = setup({ reply: () => Response.json({ text: "  ", language: null }) });
    await nothing.d.toggle("en", nothing.onText);
    await nothing.d.toggle("en", nothing.onText);
    await nothing.settle();
    expect(nothing.d.get()).toMatchObject({ state: "error", error: "empty" });

    const busy = setup({ reply: () => Response.json({ code: "rate_limited" }, { status: 429 }) });
    await busy.d.toggle("en", busy.onText);
    await busy.d.toggle("en", busy.onText);
    await busy.settle();
    expect(busy.d.get()).toMatchObject({ state: "error", error: "busy" });

    const failed = setup({ reply: () => Response.json({ code: "upstream" }, { status: 502 }) });
    await failed.d.toggle("en", failed.onText);
    await failed.d.toggle("en", failed.onText);
    await failed.settle();
    expect(failed.d.get()).toMatchObject({ state: "error", error: "failed" });
    expect(failed.texts).toEqual([]);
  });

  it("releases the microphone and drops the clip when the page leaves mid-recording", async () => {
    const t = setup();
    await t.d.toggle("en", t.onText);
    t.d.dispose();
    await t.settle();
    expect(t.track.stop).toHaveBeenCalled();
    expect(t.posts).toHaveLength(0);
    expect(t.texts).toEqual([]);
  });
});
