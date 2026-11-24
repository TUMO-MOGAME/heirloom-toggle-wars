"use client";
/**
 * Voice typing's microphone (plan §20.1 item 2), for the chat composer and the plan builder. Tap to speak, tap again
 * to stop; the words come back through `onText` for the box (the caller appends them and never sends). Shows which
 * language it listens in, a one-line privacy notice on first use, and every state in a live region.
 *
 * `useMicButton` returns the button and the status line separately, so each composer places them in its own layout.
 */
import { useCallback, useState, type ReactNode } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Loader2, Mic, MicOff, Square } from "@/components/ui/icons";
import { fmt } from "@/components/shell/copy";
import { listen as listenEnglish } from "@/content/listen";
import { useLocalized } from "@/lib/i18n/client";
import { VOICE_LANGUAGES } from "@/lib/voice/languages";
import { useVoiceLanguage } from "@/lib/voice/languages-client";
import { useDictation } from "@/lib/voice/useDictation";

/** Remembers that the privacy notice was shown once, so it isn't repeated every time (no cookie). */
const NOTICE_KEY = "heirloom.dictationNotice";
const noticeSeen = () => { try { return window.localStorage.getItem(NOTICE_KEY) === "1"; } catch { return false; } };
const markNoticeSeen = () => { try { window.localStorage.setItem(NOTICE_KEY, "1"); } catch { /* storage blocked */ } };

/** Puts dictated words after what is already in the box, with one space between. Never sends. */
export function appendTranscript(current: string, text: string): string {
  const add = text.trim();
  if (!add) return current;
  const base = current.replace(/\s+$/, "");
  return base ? `${base} ${add}` : add;
}

export function useMicButton({ onText, disabled, className, statusClassName }: { onText: (text: string) => void; disabled?: boolean; className?: string; statusClassName?: string }): { button: ReactNode; status: ReactNode } {
  const copy = useLocalized(listenEnglish, (t) => t.listen);
  const { lang } = useVoiceLanguage("listen");
  const name = VOICE_LANGUAGES[lang].name;
  const [showNotice, setShowNotice] = useState(false);
  const [done, setDone] = useState(false);
  const received = useCallback((text: string) => { setDone(true); markNoticeSeen(); onText(text); }, [onText]);
  const d = useDictation(received);
  const recording = d.state === "recording";
  const busy = d.state === "checking" || d.state === "transcribing";

  const press = () => {
    setDone(false);
    if (!recording && !noticeSeen()) setShowNotice(true);
    d.toggle(lang);
  };

  const label = recording ? copy.stop : fmt(copy.start, { language: name });
  const Icon = recording ? Square : busy ? Loader2 : d.state === "unavailable" ? MicOff : Mic;
  const button = (
    <button
      type="button" onClick={press} disabled={(disabled && !recording) || busy}
      aria-pressed={recording} aria-label={label} title={label}
      className={clsx(
        "relative grid size-11 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50",
        recording ? "border-ink bg-ink text-bg hover:bg-ink" : "border-line-strong bg-surface text-ink hover:bg-surface-2",
        className,
      )}
    >
      {recording && <span aria-hidden="true" className="pointer-events-none absolute -inset-1 rounded-full border-2 border-ink motion-safe:animate-pulse-soft" />}
      <Icon className={clsx("size-5", recording && "size-4", busy && "motion-safe:animate-spin")} aria-hidden="true" />
    </button>
  );

  const message =
    d.state === "checking" ? copy.checking
    : recording ? fmt(copy.listening, { language: VOICE_LANGUAGES[d.language ?? lang].name })
    : d.state === "transcribing" ? copy.transcribing
    : d.state === "unavailable" ? copy.unavailable
    : d.state === "error" && d.error ? copy.errors[d.error]
    : done ? copy.done
    : "";
  const notice = showNotice && (recording || busy);
  const status = (
    <div className={clsx("min-w-0 text-small text-ink-2", (message || notice) && statusClassName)} data-dictation-status>
      <p role="status" aria-live="polite" className={clsx(d.state === "error" || d.state === "unavailable" ? "font-medium text-ink" : "", !message && "sr-only")}>{message}</p>
      {notice && (
        <p className="mt-0.5">
          {copy.notice}{" "}
          <Link href="/privacy" className="font-medium text-ink underline underline-offset-2">{copy.privacyLink}</Link>
        </p>
      )}
    </div>
  );
  return { button, status };
}
