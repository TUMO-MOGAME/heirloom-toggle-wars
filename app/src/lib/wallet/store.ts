/**
 * localStorage persistence of the device's wallets: address, label, role and the PIN-encrypted seed.
 * Every access is guarded (private mode / blocked storage just means "no saved wallets").
 */
import type { Base58, Role } from "../types";
import type { EncryptedSeed } from "./crypto";

/** A Heirloom (Tether WDK) wallet: the seed is kept here, encrypted with the PIN. */
export interface StoredWdkWallet { kind?: "wdk"; address: Base58; label: string; role: Role; enc: EncryptedSeed; createdAt: number }
/** A phone wallet (Wallet Standard / MWA): only its public address and the wallet app's name. The keys stay in that app. */
export interface StoredPhoneWallet { kind: "phone"; address: Base58; label: string; role: Role; wallet: string; createdAt: number }
export type StoredWallet = StoredWdkWallet | StoredPhoneWallet;

export const isPhoneWallet = (w: StoredWallet): w is StoredPhoneWallet => w.kind === "phone";

const KEY = "heirloom.wallets.v1";
/** The wallet this device last acted as. */
export const ACTIVE_WALLET_KEY = "heirloom.wallets.active";
const ACTIVE = ACTIVE_WALLET_KEY;

/** The stored list with one wallet's role changed (nothing else about the wallet changes). */
export function withRole(list: StoredWallet[], address: Base58, role: Role): StoredWallet[] {
  return list.map((w) => (w.address === address ? { ...w, role } : w));
}

export function loadWallets(): StoredWallet[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredWallet[]).filter((w) => w && typeof w.address === "string" && (isPhoneWallet(w) ? typeof w.wallet === "string" : Boolean(w.enc))) : [];
  } catch {
    return [];
  }
}

export function saveWallets(list: StoredWallet[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export function loadActive(): Base58 | null {
  try { return localStorage.getItem(ACTIVE); } catch { return null; }
}

export function saveActive(address: Base58 | null): void {
  try {
    if (address) localStorage.setItem(ACTIVE, address); else localStorage.removeItem(ACTIVE);
  } catch { /* storage unavailable */ }
}
