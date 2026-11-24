"use client";
/**
 * "Hear it": a payment's receipt read aloud (plan §20.1 item 3), beside its Explorer link. A tap asks the server for
 * the receipt (POST /api/voice/receipt); the server builds the words from the payment itself, so the browser only
 * names the payment: its signature on devnet, the demo's receipt id in the demo. A short chime plays first (when the
 * shipped chime file exists), then the voice. Without a voice (no ElevenLabs key, or a language it can't speak) the
 * words are shown instead: the browser's own speech voice is never used (decision 18 Nov 2026).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Loader2, Square, Volume2 } from "@/components/ui/icons";
import { receipts as english } from "@/content/receipts";
import { useLocalized } from "@/lib/i18n/client";
import type { ActivityItem } from "@/lib/types";
import { VOICE_LANGUAGES, isVoiceLanguage, type VoiceLanguage } from "@/lib/voice/languages";
import { useVoiceLanguage } from "@/lib/voice/languages-client";
import { PAYMENT_CHIME_SRC, demoReceiptId, receiptKindOf, type DemoReceiptSource } from "@/lib/voice/receipts";

const isChain = () => process.env.NEXT_PUBLIC_DATA_MODE === "chain";

/** The request body for this payment, or null when it has no receipt to hear. */
export function receiptRequest(item: ActivityItem, demo: Omit<DemoReceiptSource, "item">): Record<string, string> | null {
  if (!item.txSignature || !receiptKindOf(item.kind)) return null;
  if (isChain()) {
    const payee = item.payment?.payee ?? item.sale?.recipient;
    return { signature: item.txSignature, ...(payee ? { payee } : {}) };
  }
  const receiptId = demoReceiptId({ item, ...demo });
  return receiptId ? { receiptId } : null;
}

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "playing"; text: string; lang: VoiceLanguage; machine: boolean }
  | { phase: "done"; text: string; lang: VoiceLanguage; machine: boolean }
  | { phase: "text"; reason: "unavailable" | "notSpoken"; text: string; lang: VoiceLanguage; machine: boolean }
  | { phase: "error"; reason: "failed" | "limited" | "notFound" };

interface ReceiptResponse { text?: string; lang?: string; spoken?: boolean; translated?: string; audio?: string | null; code?: string }

/** Only one receipt plays at a time, across every list on the page. */
let stopCurrent: (() => void) | null = null;

/** A tenth of a second of silence (a WAV built here, so it plays as blob: under the CSP), to unlock audio on a tap. */
function silentWav(): Blob {
  const rate = 8000, n = 800;
  const b = new DataView(new ArrayBuffer(44 + n));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); b.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true);
  b.setUint16(22, 1, true); b.setUint32(24, rate, true); b.setUint32(28, rate, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true);
  w(36, "data"); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return new Blob([b.buffer], { type: "audio/wav" });
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mpeg" });
}

export function ReceiptButton({ item, demo = {}, className }: { item: ActivityItem; demo?: Omit<DemoReceiptSource, "item">; className?: string }) {
  const copy = useLocalized(english, (t) => t.receipts);
  const { lang } = useVoiceLanguage("speech");
  const [state, setState] = useState<State>({ phase: "idle" });
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef<string[]>([]);
  const run = useRef(0);

  const stop = useCallback(() => {
    run.current++;
    audio.current?.pause();
    audio.current = null;
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current = [];
    setState((s) => (s.phase === "playing" ? { ...s, phase: "done" } : s.phase === "loading" ? { phase: "idle" } : s));
  }, []);

  useEffect(() => () => {
    if (stopCurrent === stop) stopCurrent = null;
    run.current++;
    audio.current?.pause();
    urls.current.forEach((u) => URL.revokeObjectURL(u));
  }, [stop]);

  const body = receiptRequest(item, demo);
  if (!body) return null;

  /** Plays `src` on the element unlocked by the tap; resolves when it ends, false if it could not play. */
  const playOn = (a: HTMLAudioElement, src: string, id: number) => new Promise<boolean>((resolve) => {
    if (id !== run.current) { resolve(false); return; }
    a.onended = () => resolve(true);
    a.onerror = () => resolve(false);
    a.src = src;
    void a.play().catch(() => resolve(false));
  });

  const start = async () => {
    stopCurrent?.();
    stopCurrent = stop;
    const id = ++run.current;
    // Unlock audio inside the tap (iOS Safari only plays sound started by a gesture; the fetch comes after it).
    const a = new Audio();
    audio.current = a;
    const silent = URL.createObjectURL(silentWav());
    urls.current.push(silent);
    a.src = silent;
    void a.play().catch(() => { /* blocked: the words are still shown */ });
    setState({ phase: "loading" });

    let res: Response;
    let data: ReceiptResponse = {};
    try {
      res = await fetch("/api/voice/receipt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, lang }) });
      data = (await res.json().catch(() => ({}))) as ReceiptResponse;
    } catch {
      if (id === run.current) setState({ phase: "error", reason: "failed" });
      return;
    }
    if (id !== run.current) return;
    const spokenLang = isVoiceLanguage(data.lang) ? data.lang : lang;
    const machine = data.translated === "machine";
    if (typeof data.text === "string" && data.text && (res.status === 503 || (res.ok && !data.audio))) {
      setState({ phase: "text", reason: res.ok ? "notSpoken" : "unavailable", text: data.text, lang: spokenLang, machine });
      return;
    }
    if (!res.ok || !data.audio || !data.text) {
      setState({ phase: "error", reason: res.status === 429 ? "limited" : res.status === 404 ? "notFound" : "failed" });
      return;
    }
    const speech = URL.createObjectURL(base64ToBlob(data.audio));
    urls.current.push(speech);
    const words = { text: data.text, lang: spokenLang, machine };
    setState({ phase: "playing", ...words });
    if (PAYMENT_CHIME_SRC) await playOn(a, PAYMENT_CHIME_SRC, id);
    const ok = await playOn(a, speech, id);
    if (id !== run.current) return;
    setState(ok ? { phase: "done", ...words } : { phase: "text", reason: "unavailable", ...words });
  };

  const playing = state.phase === "playing" || state.phase === "loading";
  const shown = state.phase === "playing" || state.phase === "done" || state.phase === "text" ? state : null;
  const info = shown ? VOICE_LANGUAGES[shown.lang] : null;
  const status = state.phase === "loading" ? copy.loading
    : state.phase === "playing" ? copy.playing
      : state.phase === "done" ? copy.done
        : state.phase === "text" ? (state.reason === "unavailable" ? copy.textOnly : copy.notSpoken)
          : state.phase === "error" ? copy[state.reason] : "";

  return (
    <>
      <button
        type="button"
        onClick={() => (playing ? stop() : void start())}
        aria-pressed={playing}
        className={clsx(
          "print-hide inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-small font-semibold text-ink underline decoration-ink decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2",
          className,
        )}
      >
        {state.phase === "loading"
          ? <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          : state.phase === "playing"
            ? <Square className="size-3.5 shrink-0" aria-hidden="true" />
            : <Volume2 className="size-4 shrink-0" aria-hidden="true" />}
        <span>{playing ? copy.stop : copy.hear}</span>
        <span className="sr-only">{playing ? copy.stopSr : copy.hearSr}</span>
      </button>
      <div role="status" aria-live="polite" className={clsx("print-hide basis-full text-small", !status && "sr-only")}>
        {status && <p className={clsx("text-ink-2", state.phase === "playing" && "motion-safe:animate-pulse")}>{status}</p>}
        {shown && info && (
          <p lang={info.tag} dir={info.rtl ? "rtl" : undefined} className="mt-0.5 font-medium text-ink">
            {shown.text}
            {shown.machine && <span className="ms-1 text-[0.75rem] font-normal text-ink-2">({copy.machine})</span>}
          </p>
        )}
        {shown && state.phase !== "text" && <p className="text-[0.75rem] text-ink-2">{copy.voice}</p>}
      </div>
    </>
  );
}
