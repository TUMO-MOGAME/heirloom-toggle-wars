"use client";
/**
 * App-wide client state: the active service, the estate snapshot for whoever is acting, the ZAR rate,
 * a `run()` helper for writes (busy state, friendly errors, refresh, toast), and small UI intents that
 * let the agent open things for the user (a prefilled claim, a rule, an upload).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getService, type EstateSnapshot, type HeirloomService } from "../service";
import { isMockService } from "../service/is-mock";
import { isFreshDemoVisit } from "../service/fresh-visit";
import { chainConfig } from "../chain/config";
import type { DemoStage } from "../service/mock";
import type { FxRate, Role, WalletSession } from "../types";
import { useWallet } from "./wallet-source";
import { linkedEstate, pickEstate, uniqueEstates, type EstateChoice } from "./pick-estate";

export type RunResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
export type Intent =
  | { kind: "claim"; rule?: string; payee?: string; amount?: number }
  | { kind: "rule"; rule: string }
  | { kind: "upload"; purpose: "death" | "claim" | "hardship" }
  /** Opens "Ask for money" (components/ask), optionally on one rule. */
  | { kind: "ask"; rule?: string };
export interface Toast { id: number; tone: "ok" | "error" | "info"; text: string }
export type AgentMode = "chat" | "call";
export type DemoShortcut = "simulatePassing" | "skipWait" | "makeDue";

interface EstateCtx {
  service: HeirloomService | null;
  isMock: boolean;
  phase: "loading" | "empty" | "ready" | "error";
  snap: EstateSnapshot | null;
  /** Every estate the acting wallet belongs to (one entry each), for the estate switcher. */
  estates: EstateChoice[];
  /** The estate on screen (it may be one the wallet has no role in, opened from a listing link). */
  estate: string | null;
  /** Opens another estate and remembers the choice on this device (heirloom.lastEstate). */
  chooseEstate(estate: string): void;
  fx: FxRate | null;
  loadError: string | null;
  session: WalletSession | null;
  role: Role | null;
  /** Spendable USD₮ of the acting wallet (base units). */
  walletUsdt: bigint;
  busy: string | null;
  refresh(): Promise<void>;
  /** Runs a write. `silent` skips the error toast for callers that show the refusal in place. */
  run<T>(key: string, fn: (svc: HeirloomService, estate: string) => Promise<T>, success?: string, silent?: boolean): Promise<RunResult<T>>;
  explain(error: unknown): { code: string; message: string };
  toasts: Toast[];
  notify(tone: Toast["tone"], text: string): void;
  dismiss(id: number): void;
  intent: Intent | null;
  setIntent(i: Intent | null): void;
  agent: AgentMode | null;
  openAgent(mode: AgentMode): void;
  closeAgent(): void;
  proofOpen: boolean;
  setProofOpen(open: boolean): void;
  resetDemo(stage: DemoStage): Promise<void>;
  /** Mock-only shortcuts for a quick demo. Returns false if the shortcut does not apply right now. */
  demoShortcut(kind: DemoShortcut): Promise<boolean>;
}

const Ctx = createContext<EstateCtx | null>(null);
const LAST_ESTATE = "heirloom.lastEstate";

/** A value's content as a string (bigints included), to tell a changed snapshot from a re-fetched identical one. */
const contentKey = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));

export function EstateProvider({ children, errors }: { children: ReactNode; errors: Record<string, string> }) {
  const wallet = useWallet();
  const session = wallet.session;
  const [service, setService] = useState<HeirloomService | null>(null);
  const [phase, setPhase] = useState<EstateCtx["phase"]>("loading");
  // A first demo visit has no estate yet, so the "no estate" screen can show as soon as the wallet is ready rather than
  // after the demo service's code has downloaded (a slow phone notices). The service still loads and confirms it.
  // Never in chain mode. Set after hydration (the demo guide renders by phase, so the first render must match the server).
  const assumedEmpty = useRef(false);
  useEffect(() => {
    if (chainConfig.dataMode !== "mock" || !isFreshDemoVisit()) return;
    assumedEmpty.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase((p) => (p === "loading" ? "empty" : p));
  }, []);
  const [snap, setSnap] = useState<EstateSnapshot | null>(null);
  const [estates, setEstates] = useState<EstateChoice[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  // A choice made in this visit: the switcher (for this wallet and role) or a shared listing link (?estate=).
  const chosen = useRef<{ estate: string; who: string | null; link: boolean } | null>(null);
  const linkRead = useRef(false);
  const [fx, setFx] = useState<FxRate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [agent, setAgent] = useState<AgentMode | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [walletUsdt, setWalletUsdt] = useState<bigint>(BigInt(0));
  const estateRef = useRef<string | null>(null);
  const snapKey = useRef<string | null>(null);
  const toastId = useRef(0);
  const loadSeq = useRef(0);
  const inFlight = useRef(0);

  const explain = useCallback((error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    // A refusal that carries its code ("recurring_payee", "residual") needn't repeat it in the message.
    const given = (error as { code?: unknown } | null)?.code;
    if (typeof given === "string" && given !== "generic" && Object.hasOwn(errors, given)) return { code: given, message: errors[given] };
    const code = Object.keys(errors).find((k) => k !== "generic" && new RegExp(`\\b${k}\\b`).test(raw)) ?? "generic";
    return { code, message: errors[code] ?? errors.generic ?? raw };
  }, [errors]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback((tone: Toast["tone"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, tone, text }]);
    window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4500);
  }, [dismiss]);

  useEffect(() => {
    let alive = true;
    getService().then((s) => { if (alive) setService(s); }).catch((e) => {
      if (!alive) return;
      setLoadError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    });
    return () => { alive = false; };
  }, []);

  const address = session?.address ?? null;
  const sessionRole = session?.role ?? null;
  const sessionLabel = session?.label ?? null;
  const sessionUsdt = session?.usdtBalance ?? BigInt(0);

  const load = useCallback(async (quiet: boolean) => {
    if (!service) return;
    // A background refresh never overtakes a load still in flight: on a slow or rate-limited RPC a load can take
    // longer than the poll interval, and each new load would discard the previous one, so nothing would ever land.
    if (quiet && inFlight.current > 0) return;
    const seq = ++loadSeq.current;
    inFlight.current++;
    if (!quiet && !assumedEmpty.current) setPhase((p) => (p === "ready" ? p : "loading"));
    try {
      if (isMockService(service)) {
        service.setActor(address && sessionRole && sessionLabel ? { address, role: sessionRole, label: sessionLabel } : null);
      }
      const [list, rate] = await Promise.all([
        address ? service.listEstatesFor(address) : Promise.resolve([]),
        service.getFx().catch(() => null),
      ]);
      const chain = !isMockService(service);
      if (!linkRead.current) {
        linkRead.current = true;
        const linked = linkedEstate(window.location.search);
        if (linked) {
          chosen.current = { estate: linked, who: null, link: true };
          // Kept for later visits too: a buyer who sets up a wallet after opening the link still finds the listing.
          try { window.localStorage.setItem(LAST_ESTATE, linked); } catch { /* ignore */ }
        }
      }
      let remembered: string | null = null;
      try { remembered = window.localStorage.getItem(LAST_ESTATE); } catch { /* ignore */ }
      const who = `${address}:${sessionRole}`;
      const pick = chosen.current && (chosen.current.who === null || chosen.current.who === who) ? chosen.current : null;
      const unique = uniqueEstates(list);
      const estate = pickEstate(unique, { chosen: pick?.estate ?? null, chosenByLink: pick?.link, remembered, role: sessionRole, chain });
      if (seq !== loadSeq.current) return;
      setEstates((prev) => (contentKey(prev) === contentKey(unique) ? prev : unique));
      // The background poll re-fetches every few seconds; unchanged data keeps the same object, so the app
      // doesn't re-render for nothing (phones notice).
      if (rate) setFx((prev) => (prev && prev.usdtZar === rate.usdtZar && prev.source === rate.source ? prev : rate));
      setWalletUsdt(isMockService(service) && address ? service.balanceOf(address) ?? sessionUsdt : sessionUsdt);
      if (!estate) {
        estateRef.current = null;
        snapKey.current = null;
        setCurrent(null);
        setSnap(null);
        setPhase("empty");
        return;
      }
      const next = await service.getEstate(estate);
      if (seq !== loadSeq.current) return;
      estateRef.current = estate;
      setCurrent(estate);
      try { window.localStorage.setItem(LAST_ESTATE, estate); } catch { /* ignore */ }
      const key = contentKey(next);
      if (key !== snapKey.current) { snapKey.current = key; setSnap(next); }
      setLoadError(null);
      setPhase("ready");
    } catch (e) {
      if (seq !== loadSeq.current) return;
      if (quiet && estateRef.current) return; // keep showing the last good data during a blip
      setLoadError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      inFlight.current--;
      assumedEmpty.current = false;
    }
  }, [service, address, sessionRole, sessionLabel, sessionUsdt]);

  // Fetching on mount / when the session changes; load() marks the phase as loading before it awaits.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(false); }, [load]);

  useEffect(() => {
    if (!service) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, isMockService(service) ? 5000 : 15000); // public RPCs rate-limit: poll the chain less often
    return () => window.clearInterval(id);
  }, [service, load]);

  const chooseEstate = useCallback((estate: string) => {
    chosen.current = { estate, who: `${address}:${sessionRole}`, link: false };
    try { window.localStorage.setItem(LAST_ESTATE, estate); } catch { /* ignore */ }
    void load(false);
  }, [address, sessionRole, load]);

  const refresh = useCallback(async () => {
    await load(true);
    void wallet.refreshBalances().catch(() => undefined);
  }, [load, wallet]);

  const run = useCallback(async <T,>(key: string, fn: (svc: HeirloomService, estate: string) => Promise<T>, success?: string, silent = false): Promise<RunResult<T>> => {
    if (!service) return { ok: false, code: "generic", message: errors.generic };
    setBusy(key);
    try {
      const value = await fn(service, estateRef.current ?? "");
      await load(true);
      void wallet.refreshBalances().catch(() => undefined);
      if (success) notify("ok", success);
      return { ok: true, value };
    } catch (e) {
      const { code, message } = explain(e);
      if (!silent) notify("error", message);
      await load(true);
      return { ok: false, code, message };
    } finally {
      setBusy(null);
    }
  }, [service, errors, load, wallet, notify, explain]);

  const resetDemo = useCallback(async (stage: DemoStage) => {
    // On a first visit the "no estate" screen can show before the service has loaded: wait for it here.
    const svc = service ?? (chainConfig.dataMode === "mock" ? await getService().catch(() => null) : null);
    if (!isMockService(svc)) return;
    svc.resetDemo(stage);
    await load(false);
  }, [service, load]);

  // Demo links: "?demo=funded" (or any stage) resets the simulated estate to that point once, then drops the
  // parameter, so a shared link always opens the same story whatever this browser saved before. Mock mode only.
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || !isMockService(service)) return;
    linked.current = true;
    const url = new URL(window.location.href);
    const stage = url.searchParams.get("demo");
    if (!stage) return;
    // The demo module is already loaded here (the service is the mock), so this import costs nothing.
    void import("../service/mock").then(({ DEMO_STAGES }) => {
      if (!(DEMO_STAGES as readonly string[]).includes(stage)) return;
      url.searchParams.delete("demo");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      return resetDemo(stage as DemoStage);
    });
  }, [service, resetDemo]);

  const demoShortcut = useCallback(async (kind: DemoShortcut) => {
    if (!isMockService(service)) return false;
    try {
      service[kind]();
      await load(true);
      return true;
    } catch (e) {
      notify("error", explain(e).message);
      return false;
    }
  }, [service, load, notify, explain]);

  const value = useMemo<EstateCtx>(() => ({
    service, isMock: isMockService(service), phase, snap, estates, estate: current, chooseEstate, fx, loadError, session, role: session?.role ?? null, walletUsdt, busy,
    refresh, run, explain, toasts, notify, dismiss, intent, setIntent,
    agent, openAgent: setAgent, closeAgent: () => setAgent(null), proofOpen, setProofOpen, resetDemo, demoShortcut,
  }), [demoShortcut, service, phase, snap, estates, current, chooseEstate, fx, loadError, session, walletUsdt, busy, refresh, run, explain, toasts, notify, dismiss, intent, agent, proofOpen, resetDemo]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEstate(): EstateCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEstate must be used inside <EstateProvider>");
  return v;
}
