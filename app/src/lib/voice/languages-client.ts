"use client";
/**
 * The spoken-language choice in the browser (plan §20). Unset means "follow the UI language". Every voice feature
 * (call, dictation, receipts, Legacy Voice) reads it through `useVoiceLanguage(capability)`, so one picker serves all.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useLocale } from "../i18n/client";
import { VOICE_LANGUAGE_STORAGE_KEY, isVoiceLanguage, resolveVoiceLanguage, type VoiceCapability, type VoiceLanguage } from "./languages";

const EVENT = "heirloom:voice-language";

function read(): VoiceLanguage | null {
  try {
    const v = window.localStorage.getItem(VOICE_LANGUAGE_STORAGE_KEY);
    return isVoiceLanguage(v) ? v : null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Choose a spoken language; null goes back to following the UI language. */
export function setVoiceLanguage(lang: VoiceLanguage | null): void {
  try {
    if (lang) window.localStorage.setItem(VOICE_LANGUAGE_STORAGE_KEY, lang);
    else window.localStorage.removeItem(VOICE_LANGUAGE_STORAGE_KEY);
  } catch { /* storage blocked: the choice lasts for this page only */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The chosen spoken language (null = follow the UI), and the one to use for `capability`. */
export function useVoiceLanguage(capability: VoiceCapability): { chosen: VoiceLanguage | null; lang: VoiceLanguage; set: (l: VoiceLanguage | null) => void } {
  const chosen = useSyncExternalStore(subscribe, read, () => null);
  const ui = useLocale();
  const set = useCallback((l: VoiceLanguage | null) => setVoiceLanguage(l), []);
  return { chosen, lang: resolveVoiceLanguage(capability, chosen, ui), set };
}
