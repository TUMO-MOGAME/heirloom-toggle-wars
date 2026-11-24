"use client";
/**
 * Voice typing (plan §20.1 item 2): tap to record, tap again to stop; the clip goes to /api/voice/transcribe (ElevenLabs
 * Scribe) and the words come back through `onText` for the person to read, edit and send themselves. Nothing is sent
 * by voice alone. Never the browser's own speech recognition (project rule: ElevenLabs only).
 *
 * `createDictation` is the state machine, with the browser's pieces passed in so it can be tested in Node;
 * `useDictation` is the React wrapper. The microphone is released as soon as a clip ends, fails or the page leaves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceLanguage } from "./languages";
import { DICTATION_BITRATE, DICTATION_MAX_SECS, baseType } from "./transcribe";

export type DictationState = "idle" | "checking" | "recording" | "transcribing" | "error" | "unavailable";
/** blocked: no microphone permission; unsupported: no recorder here; empty: nothing heard; busy: limits; failed: other. */
export type DictationError = "blocked" | "unsupported" | "empty" | "busy" | "failed";

export interface DictationSnapshot {
  state: DictationState;
  error: DictationError | null;
  /** The language the current or last clip was sent in (null = detect). */
  language: VoiceLanguage | null;
}

/** The parts of MediaRecorder used here. */
export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface DictationDeps {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder?: (stream: MediaStream, mime: string | undefined) => RecorderLike;
  pickMime?: () => string | undefined;
  fetch: typeof fetch;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  endpoint?: string;
}

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export interface Dictation {
  get: () => DictationSnapshot;
  /** Starts a clip, or stops the one being recorded. */
  toggle: (language: VoiceLanguage | null, onText: (text: string) => void) => Promise<void>;
  stop: () => void;
  /** Stops everything, drops any clip and any answer still to come, and releases the microphone. */
  dispose: () => void;
}

export function createDictation(deps: DictationDeps, onChange: (s: DictationSnapshot) => void): Dictation {
  const endpoint = deps.endpoint ?? "/api/voice/transcribe";
  let snap: DictationSnapshot = { state: "idle", error: null, language: null };
  let available: boolean | null = null;
  let stream: MediaStream | null = null;
  let recorder: RecorderLike | null = null;
  let timer: unknown = null;
  let abort: AbortController | null = null;
  let disposed = false;

  const set = (s: Partial<DictationSnapshot>) => { if (disposed) return; snap = { ...snap, ...s }; onChange(snap); };
  const release = () => {
    if (timer !== null) { deps.clearTimeout(timer); timer = null; }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  const probe = async (): Promise<boolean> => {
    if (available !== null) return available;
    try {
      const r = await deps.fetch(endpoint, { method: "GET", cache: "no-store" });
      const d = (await r.json().catch(() => ({}))) as { available?: unknown };
      available = r.ok && d.available === true;
    } catch {
      return false; // offline: try again next tap
    }
    return available;
  };

  const send = async (blob: Blob, language: VoiceLanguage | null, onText: (t: string) => void) => {
    set({ state: "transcribing" });
    const form = new FormData();
    form.set("audio", blob, "speech");
    if (language) form.set("language", language);
    abort = new AbortController();
    try {
      const r = await deps.fetch(endpoint, { method: "POST", body: form, signal: abort.signal, cache: "no-store" });
      const d = (await r.json().catch(() => ({}))) as { text?: unknown; code?: unknown };
      if (r.status === 503 && d.code === "unavailable") { available = false; set({ state: "unavailable", error: null }); return; }
      if (r.status === 429 || d.code === "busy") { set({ state: "error", error: "busy" }); return; }
      if (!r.ok) { set({ state: "error", error: "failed" }); return; }
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (!text) { set({ state: "error", error: "empty" }); return; }
      set({ state: "idle", error: null });
      if (!disposed) onText(text);
    } catch {
      set({ state: "error", error: "failed" });
    } finally {
      abort = null;
    }
  };

  const stop = () => { if (recorder?.state === "recording") recorder.stop(); };

  const toggle = async (language: VoiceLanguage | null, onText: (t: string) => void) => {
    if (snap.state === "recording") { stop(); return; }
    if (snap.state === "checking" || snap.state === "transcribing") return;
    set({ state: "checking", error: null, language });
    if (!(await probe())) { set({ state: available === false ? "unavailable" : "error", error: available === false ? null : "failed" }); return; }
    if (!deps.getUserMedia || !deps.createRecorder) { set({ state: "error", error: "unsupported" }); return; }
    try {
      stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch {
      set({ state: "error", error: "blocked" });
      return;
    }
    if (disposed) { release(); return; }
    const mime = deps.pickMime?.();
    let r: RecorderLike;
    try { r = deps.createRecorder(stream, mime); } catch { release(); set({ state: "error", error: "unsupported" }); return; }
    recorder = r;
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      release();
      recorder = null;
      if (disposed) return;
      const type = baseType(r.mimeType || mime || "audio/webm");
      const blob = new Blob(chunks, { type });
      if (!blob.size) { set({ state: "error", error: "empty" }); return; }
      void send(blob, language, onText);
    };
    timer = deps.setTimeout(stop, DICTATION_MAX_SECS * 1000);
    r.start(1000);
    set({ state: "recording" });
  };

  const dispose = () => {
    disposed = true;
    abort?.abort();
    if (recorder?.state === "recording") recorder.stop();
    recorder = null;
    release();
  };

  return { get: () => snap, toggle, stop, dispose };
}

function browserDeps(): DictationDeps {
  const hasMedia = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  return {
    getUserMedia: hasMedia ? (c) => navigator.mediaDevices.getUserMedia(c) : undefined,
    createRecorder: hasMedia
      ? (s, mime) => new MediaRecorder(s, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: DICTATION_BITRATE }) as unknown as RecorderLike
      : undefined,
    pickMime: () => TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)),
    fetch: (...a) => window.fetch(...a),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
  };
}

/** Voice typing for one input box. `onText` receives the words; the caller puts them in the box (never sends them). */
export function useDictation(onText: (text: string) => void): DictationSnapshot & { toggle: (language: VoiceLanguage | null) => void; stop: () => void } {
  const [snap, setSnap] = useState<DictationSnapshot>({ state: "idle", error: null, language: null });
  const ctl = useRef<Dictation | null>(null);
  const latest = useRef(onText);
  useEffect(() => { latest.current = onText; }, [onText]);
  useEffect(() => () => { ctl.current?.dispose(); ctl.current = null; }, []);
  const toggle = useCallback((language: VoiceLanguage | null) => {
    ctl.current ??= createDictation(browserDeps(), setSnap);
    void ctl.current.toggle(language, (t) => latest.current(t));
  }, []);
  const stop = useCallback(() => ctl.current?.stop(), []);
  return { ...snap, toggle, stop };
}
