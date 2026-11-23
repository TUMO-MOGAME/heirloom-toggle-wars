"use client";
/**
 * Plays a LegacySpeech: ElevenLabs audio (the parent's cloned voice, an ElevenLabs stock voice standing in for it, or
 * Heirloom's own voice for the disclosure) through an <audio> element. The browser's own speech voice is never used
 * (decision 18 Nov 2026): with no audio, play() rejects and the screen shows the words instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LegacySpeech } from "@/lib/legacy/schema";

export class NoAudioError extends Error {
  constructor() { super("NoAudio: The voice can't play right now. The words are shown here."); this.name = "NoAudioError"; }
}

export function useLegacyPlayer() {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef<string[]>([]);

  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);

  useEffect(() => () => {
    stop();
    urls.current.forEach((u) => URL.revokeObjectURL(u));
  }, [stop]);

  /** Plays `speech`; `id` lets the UI show which item is playing. Resolves when playback ends; rejects with no audio. */
  const play = useCallback((id: string, speech: LegacySpeech) => new Promise<void>((resolve, reject) => {
    stop();
    if (!speech.audioUrl) { reject(new NoAudioError()); return; }
    setPlaying(id);
    let done = false;
    const end = (failed: boolean) => {
      if (done) return;
      done = true;
      setPlaying((p) => (p === id ? null : p));
      if (failed) reject(new NoAudioError()); else resolve();
    };
    if (speech.audioUrl.startsWith("blob:")) urls.current.push(speech.audioUrl);
    const a = new Audio(speech.audioUrl);
    audio.current = a;
    a.onended = () => end(false);
    a.onerror = () => end(true);
    a.onpause = () => { if (audio.current !== a) end(false); };
    void a.play().catch((e: unknown) => end(!(e instanceof DOMException && e.name === "AbortError")));
  }), [stop]);

  return { play, stop, playing };
}
