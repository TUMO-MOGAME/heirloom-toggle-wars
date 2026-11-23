/**
 * The phone wallet source: Wallet Standard wallets (Mobile Wallet Adapter on Android: Phantom, Solflare, the Seeker's
 * Seed Vault Wallet; or a wallet's own in-app browser), next to the Tether WDK wallets. WalletProvider (./context.tsx)
 * puts both behind the same WalletApi and ActiveSigner, so screens never care which wallet signed.
 *
 * The drivers are loaded only when a phone wallet is offered or used, so phones that never pick one never download
 * the Mobile Wallet Adapter code:
 *  - chain mode: ./phone-standard.ts (Wallet Standard registry; MWA itself is loaded only when it is chosen);
 *  - mock mode: ./phone-mock.ts, a clearly labelled simulated phone wallet for the demo.
 */
import type { Base58 } from "../types";

export interface PhoneWalletOption {
  /** Wallet Standard name, e.g. "Mobile Wallet Adapter", "Phantom", or the simulated one. */
  name: string;
  /** data: URI from the wallet, if it has one. */
  icon?: string;
  /** Mobile Wallet Adapter (opens a wallet app on this Android phone). */
  mwa: boolean;
  /** Demo only: no real wallet app is involved. */
  simulated: boolean;
}

export interface PhoneDriver {
  /** Wallets that can sign Heirloom transactions here, best first. */
  list(): Promise<PhoneWalletOption[]>;
  /** Asks the wallet for an account (the wallet shows its own approval screen). */
  connect(walletName: string): Promise<{ address: Base58; walletName: string }>;
  /** Wire bytes in, signed wire bytes out (Wallet Standard `solana:signTransaction`). Never broadcasts. */
  signTransaction(walletName: string, address: Base58, wire: Uint8Array): Promise<Uint8Array>;
  /** ed25519 signature over the message bytes (Wallet Standard `solana:signMessage`). */
  signMessage(walletName: string, address: Base58, message: Uint8Array): Promise<Uint8Array>;
  disconnect(walletName: string): Promise<void>;
}

const drivers = new Map<boolean, Promise<PhoneDriver>>();

/** Loads the right driver once per mode. */
export function loadPhoneDriver(mock: boolean): Promise<PhoneDriver> {
  let p = drivers.get(mock);
  if (!p) {
    p = mock ? import("./phone-mock").then((m) => m.mockPhoneDriver()) : import("./phone-standard").then((m) => m.standardPhoneDriver());
    p.catch(() => drivers.delete(mock));
    drivers.set(mock, p);
  }
  return p;
}
