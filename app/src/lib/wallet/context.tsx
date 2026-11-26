"use client";
/**
 * WalletProvider + useWallet(): the WalletApi (./types.ts) backed by Tether WDK.
 *
 * - chain mode: every wallet is a WDK self-custodial wallet. The seed phrase is generated on the device,
 *   encrypted with the user's PIN (PBKDF2 + AES-GCM, ./crypto.ts) into localStorage, and unlocked into
 *   memory for this tab only when it first needs to sign. Nothing about the seed is ever sent anywhere.
 * - mock mode: fixed demo personas (./personas.ts), fake signatures, no network.
 * - phone wallets (./phone.ts): a Wallet Standard wallet (Mobile Wallet Adapter on Android) can be added next to the WDK
 *   ones. Only its address and the wallet app's name are stored; it signs in its own app. Same WalletApi and
 *   ActiveSigner, so screens and the fee sponsor don't care which wallet signed. Mock mode: a simulated phone wallet.
 *
 * PIN entry: pass `requestPin` to show your own PIN sheet; the default falls back to window.prompt.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Base58, Role, WalletSession } from "../types";
import type { WalletApi } from "./types";
import { chainConfig } from "../chain/config";
import { decryptSeed, encryptSeed, assertPin } from "./crypto";
import { isPhoneWallet, loadActive, loadWallets, saveActive, saveWallets, withRole, type StoredWallet } from "./store";
import { loadPhoneDriver } from "./phone";
import type { PhoneSigner } from "./phone-signer";
import { isValidSeed, newSeedPhrase, openAccount, wdkPartialSign, wdkSign, wdkSignAndSend, type WdkAccount } from "./wdk";
import { mockSignature, personaSessions } from "./personas";
import { setActiveSigner, withActiveSigner, type ActiveSigner } from "./signer";
import { ensureReadPass } from "../access/client";

export type PinReason = "create" | "unlock";
export type RequestPin = (reason: PinReason, label: string) => Promise<string | null>;

const defaultRequestPin: RequestPin = async (reason, label) =>
  window.prompt(reason === "create" ? `Choose a PIN (6+ digits) to protect "${label}" on this device` : `Enter the PIN for "${label}"`);

const WalletContext = createContext<WalletApi | null>(null);

const toSession = (w: StoredWallet, sol = 0, usdt = 0n): WalletSession => ({
  address: w.address, label: w.label, role: w.role, solBalance: sol, usdtBalance: usdt,
  ...(isPhoneWallet(w) ? { source: "phone" as const, phoneWallet: w.wallet } : {}),
});

export function WalletProvider({ children, requestPin = defaultRequestPin }: { children: ReactNode; requestPin?: RequestPin }) {
  const isMock = chainConfig.dataMode === "mock";
  const [ready, setReady] = useState(false);
  const [sessions, setSessions] = useState<WalletSession[]>([]);
  const [activeAddr, setActiveAddr] = useState<Base58 | null>(null);
  const unlocked = useRef(new Map<Base58, WdkAccount>());
  const stored = useRef<StoredWallet[]>([]);
  const pinRef = useRef(requestPin);
  useEffect(() => { pinRef.current = requestPin; }, [requestPin]);

  // Initial load from localStorage (client only, after hydration so server and client HTML match).
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
      if (!alive) return;
      if (isMock) {
        const s = personaSessions();
        setSessions(s);
        setActiveAddr(loadActive() ?? s[0]?.address ?? null);
      } else {
        stored.current = loadWallets();
        setSessions(stored.current.map((w) => toSession(w)));
        const a = loadActive();
        setActiveAddr(a && stored.current.some((w) => w.address === a) ? a : stored.current[0]?.address ?? null);
      }
      setReady(true);
    });
    const accounts = unlocked.current;
    return () => { alive = false; accounts.forEach((a) => a.manager.dispose()); accounts.clear(); };
  }, [isMock]);

  const refreshBalances = useCallback(async () => {
    if (isMock || !stored.current.length) return;
    const wallets = [...stored.current];
    try {
      const { readBalances } = await import("../chain/balances");
      const held = await readBalances(wallets.map((w) => w.address));
      setSessions((prev) => stored.current.map((w) => {
        const b = held.get(w.address);
        return b ? { ...toSession(w, b.lamports / 1e9, b.usdt), balanceKnown: true } : prev.find((s) => s.address === w.address) ?? toSession(w);
      }));
    } catch {
      // A rate-limited read keeps the last balances: showing zero would look like the money had gone.
    }
  }, [isMock]);

  useEffect(() => { if (ready) void refreshBalances(); }, [ready, refreshBalances]);

  const persist = (list: StoredWallet[]) => { stored.current = list; saveWallets(list); };

  const addWallet = useCallback(async (label: string, role: Role, seedPhrase: string): Promise<WalletSession> => {
    const acc = await openAccount(seedPhrase, chainConfig.rpcUrl);
    const session: WalletSession = { address: acc.address, label, role, solBalance: 0, usdtBalance: 0n };
    if (isMock) {
      unlocked.current.set(acc.address, acc);
    } else {
      const pin = await pinRef.current("create", label);
      if (!pin) { acc.manager.dispose(); throw new Error("A PIN is needed to keep the wallet safe on this device."); }
      assertPin(pin);
      const enc = await encryptSeed(seedPhrase, pin);
      persist([...stored.current.filter((w) => w.address !== acc.address), { kind: "wdk", address: acc.address, label, role, enc, createdAt: Date.now() }]);
      unlocked.current.set(acc.address, acc);
      await ensureReadPass({ address: acc.address, signMessage: (m) => acc.account.sign(m) }).catch(() => undefined);
    }
    setSessions((prev) => [...prev.filter((s) => s.address !== acc.address), session]);
    setActiveAddr(acc.address);
    saveActive(acc.address);
    return session;
  }, [isMock]);

  const create = useCallback(async (label: string, role: Role) => {
    const seedPhrase = await newSeedPhrase();
    const session = await addWallet(label, role, seedPhrase);
    return { session, seedPhrase };
  }, [addWallet]);

  const importSeed = useCallback(async (label: string, role: Role, seedPhrase: string) => {
    if (!(await isValidSeed(seedPhrase))) throw new Error("That is not a valid 12 or 24-word recovery phrase.");
    return addWallet(label, role, seedPhrase);
  }, [addWallet]);

  /** Practice wallets for the people in a plan (test network): one PIN for all, and the owner stays signed in. */
  const createPractice = useCallback(async (people: { label: string; role: Role }[]): Promise<Base58[]> => {
    if (!people.length) return [];
    if (isMock) throw new Error("The demo family already has wallets.");
    // Someone already on this device keeps their wallet, so trying again never makes a second family.
    const onDevice = (p: { label: string; role: Role }) => stored.current.find((w) => w.label === p.label && w.role === p.role);
    if (people.every(onDevice)) return people.map((p) => onDevice(p)!.address);
    const pin = await pinRef.current("create", people.filter((p) => !onDevice(p)).map((p) => p.label).join(", "));
    if (!pin) throw new Error("A PIN is needed to keep the wallets safe on this device.");
    assertPin(pin);
    const made: { stored: StoredWallet; session: WalletSession }[] = [];
    const addresses: Base58[] = [];
    for (const { label, role } of people) {
      const have = onDevice({ label, role });
      if (have) {
        addresses.push(have.address);
        continue;
      }
      const phrase = await newSeedPhrase();
      const acc = await openAccount(phrase, chainConfig.rpcUrl);
      const address = acc.address;
      addresses.push(address);
      made.push({
        stored: { kind: "wdk", address, label, role, enc: await encryptSeed(phrase, pin), createdAt: Date.now() },
        session: { address, label, role, solBalance: 0, usdtBalance: 0n },
      });
      unlocked.current.set(address, acc);
      await ensureReadPass({ address, signMessage: (m) => acc.account.sign(m) }).catch(() => undefined);
    }
    persist([...stored.current, ...made.map((m) => m.stored)]);
    setSessions((prev) => [...prev, ...made.map((m) => m.session)]);
    return addresses;
  }, [isMock]);

  const connectPhone = useCallback(async (label: string, role: Role, walletName: string): Promise<WalletSession> => {
    const driver = await loadPhoneDriver(isMock);
    const { address, walletName: name } = await driver.connect(walletName);
    const session: WalletSession = { address, label, role, solBalance: 0, usdtBalance: 0n, source: "phone", phoneWallet: name, ...(isMock ? { simulated: true } : {}) };
    if (!isMock) {
      persist([...stored.current.filter((w) => w.address !== address), { kind: "phone", address, label, role, wallet: name, createdAt: Date.now() }]);
      // One signature in the wallet app, so this family's records can be read (never required to connect).
      const { toHex } = await import("./phone-sign");
      await ensureReadPass({ address, signMessage: async (m) => toHex(await driver.signMessage(name, address, new TextEncoder().encode(m))) }).catch(() => undefined);
    }
    setSessions((prev) => [...prev.filter((s) => s.address !== address), session]);
    setActiveAddr(address);
    saveActive(address);
    return session;
  }, [isMock]);

  /** The phone signer for a stored phone wallet, or null for a WDK wallet. Loaded only when a phone wallet signs. */
  const phoneFor = useCallback(async (address: Base58): Promise<PhoneSigner | null> => {
    const w = stored.current.find((x) => x.address === address);
    if (!w || !isPhoneWallet(w)) return null;
    const [driver, { phoneSigner, rpcSender }] = await Promise.all([loadPhoneDriver(false), import("./phone-signer")]);
    return phoneSigner(driver, w.wallet, address, rpcSender(chainConfig.rpcUrl));
  }, []);

  const switchTo = useCallback((address: Base58) => { setActiveAddr(address); saveActive(address); }, []);

  const setRole = useCallback((address: Base58, role: Role) => {
    if (isMock) return; // the demo personas have fixed roles
    persist(withRole(stored.current, address, role));
    setSessions((prev) => prev.map((s) => (s.address === address ? { ...s, role } : s)));
  }, [isMock]);

  const remove = useCallback((address: Base58) => {
    unlocked.current.get(address)?.manager.dispose();
    unlocked.current.delete(address);
    if (!isMock) persist(stored.current.filter((w) => w.address !== address));
    setSessions((prev) => prev.filter((s) => s.address !== address));
    setActiveAddr((cur) => {
      if (cur !== address) return cur;
      if (!isMock) saveActive(null);
      return null;
    });
  }, [isMock]);

  const lockAll = useCallback(() => {
    if (isMock) return; // demo personas have no PIN
    unlocked.current.forEach((a) => a.manager.dispose());
    unlocked.current.clear();
  }, [isMock]);

  const unlock = useCallback(async (address: Base58): Promise<WdkAccount> => {
    const hit = unlocked.current.get(address);
    if (hit) return hit;
    const w = stored.current.find((x) => x.address === address);
    if (!w) throw new Error("This wallet is not stored on this device.");
    if (isPhoneWallet(w)) throw new Error("This wallet signs in your phone wallet app.");
    const pin = await pinRef.current("unlock", w.label);
    if (!pin) throw new Error("Signing cancelled.");
    const acc = await openAccount(await decryptSeed(w.enc, pin), chainConfig.rpcUrl);
    if (acc.address !== address) { acc.manager.dispose(); throw new Error("Stored wallet does not match its address."); }
    unlocked.current.set(address, acc);
    // The wallet is open, so this needs no second prompt: from now on the family's records show without a PIN.
    await ensureReadPass({ address, signMessage: (m) => acc.account.sign(m) }).catch(() => undefined);
    return acc;
  }, []);

  const signAndSendAs = useCallback(async (address: Base58, base64Tx: string): Promise<string> => {
    if (isMock) return mockSignature();
    const phone = await phoneFor(address);
    if (phone) return phone.signAndSend(base64Tx);
    const acc = await unlock(address);
    return wdkSignAndSend(acc.account, base64Tx);
  }, [isMock, unlock, phoneFor]);

  const signOnlyAs = useCallback(async (address: Base58, base64Tx: string) => {
    if (isMock) { const signature = mockSignature(); return { signature, wireBase64: "" }; }
    const phone = await phoneFor(address);
    if (phone) return phone.signOnly(base64Tx);
    const acc = await unlock(address);
    return wdkSign(acc.account, base64Tx);
  }, [isMock, unlock, phoneFor]);

  const signPartialAs = useCallback(async (address: Base58, base64Tx: string) => {
    if (isMock) { const signature = mockSignature(); return { signature, wireBase64: "" }; }
    const phone = await phoneFor(address);
    if (phone) return phone.signPartial(base64Tx);
    const acc = await unlock(address);
    return wdkPartialSign(acc.account, base64Tx);
  }, [isMock, unlock, phoneFor]);

  const signMessageAs = useCallback(async (address: Base58, message: string): Promise<string> => {
    if (isMock) return "demo";
    const phone = await phoneFor(address);
    if (phone) return phone.signMessage(message);
    const acc = await unlock(address);
    return acc.account.sign(message);
  }, [isMock, unlock, phoneFor]);

  const signAndSend = useCallback(async (base64Tx: string) => {
    if (!activeAddr) throw new Error("No wallet is active. Create or choose a wallet first.");
    return signAndSendAs(activeAddr, base64Tx);
  }, [activeAddr, signAndSendAs]);

  const signerFor = useCallback((address: Base58): ActiveSigner => ({
    address,
    signAndSend: (tx) => signAndSendAs(address, tx),
    signOnly: (tx) => signOnlyAs(address, tx),
    signPartial: (tx) => signPartialAs(address, tx),
    signMessage: (m) => signMessageAs(address, m),
    canSignQuietly: () => isMock || unlocked.current.has(address),
  }), [isMock, signAndSendAs, signOnlyAs, signPartialAs, signMessageAs]);

  // Keep the non-React signer (used by service/chain.ts) in step with the active wallet.
  useEffect(() => {
    setActiveSigner(activeAddr ? signerFor(activeAddr) : null);
  }, [activeAddr, signerFor]);

  /** The guided run: a wallet stored on this device signs `work` in the background; the active wallet stays. */
  const actAs = useCallback(<T,>(address: Base58, work: () => Promise<T>): Promise<T> => {
    if (!isMock && !stored.current.some((w) => w.address === address)) return Promise.reject(new Error("This wallet is not stored on this device."));
    return withActiveSigner(signerFor(address), work);
  }, [isMock, signerFor]);

  const session = sessions.find((s) => s.address === activeAddr) ?? null;
  const api = useMemo<WalletApi>(() => ({
    ready, session, sessions, create, createPractice, importSeed, connectPhone, switchTo, setRole, remove, lockAll, refreshBalances, signAndSend, actAs,
  }), [ready, session, sessions, create, createPractice, importSeed, connectPhone, switchTo, setRole, remove, lockAll, refreshBalances, signAndSend, actAs]);

  return <WalletContext.Provider value={api}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletApi {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet() must be used inside <WalletProvider>.");
  return ctx;
}
