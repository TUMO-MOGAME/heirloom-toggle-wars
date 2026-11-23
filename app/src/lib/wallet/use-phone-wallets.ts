"use client";
/**
 * Which phone wallets this device offers, for "Use my phone wallet". Checked when the browser is idle, so the
 * screen's first paint never waits for it. Chain mode: Mobile Wallet Adapter on Android, plus any Wallet Standard
 * wallet that is installed (a wallet's in-app browser or extension). Mock mode: the simulated phone wallet.
 * An empty list means: don't offer the option.
 */
import { useEffect, useState } from "react";
import { chainConfig } from "../chain/config";
import { loadPhoneDriver, type PhoneWalletOption } from "./phone";

export function usePhoneWallets(): { checked: boolean; options: PhoneWalletOption[] } {
  const [state, setState] = useState<{ checked: boolean; options: PhoneWalletOption[] }>({ checked: false, options: [] });
  useEffect(() => {
    let alive = true;
    const check = () => {
      loadPhoneDriver(chainConfig.dataMode === "mock")
        .then((d) => d.list())
        .then((options) => { if (alive) setState({ checked: true, options }); })
        .catch(() => { if (alive) setState({ checked: true, options: [] }); });
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(check, { timeout: 1500 }); else window.setTimeout(check, 300);
    // Wallets injected by an in-app browser can register a moment after the page loads: look once more.
    const again = window.setTimeout(check, 2500);
    return () => { alive = false; window.clearTimeout(again); };
  }, []);
  return state;
}
