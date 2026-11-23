/**
 * Chain mode phone wallet driver: Wallet Standard wallets plus Mobile Wallet Adapter (@solana-mobile/wallet-standard-mobile).
 * Loaded lazily by ./phone.ts. The MWA package itself is imported only when MWA is chosen (connect or sign), so
 * listing the wallets on /start costs only the tiny Wallet Standard registry.
 *
 * MWA on Android (local association): the page opens the wallet app with an Android intent and talks to it over a
 * WebSocket on ws://localhost (allowed in next.config.ts's CSP). Chrome asks once for Local Network Access; MWA
 * 0.5+ shows its own explainer dialog for that. Authorisations are cached by MWA in localStorage (public keys and an
 * auth token only, never keys), so a reload reconnects silently.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { chainConfig } from "../chain/config";
import type { PhoneDriver, PhoneWalletOption } from "./phone";
import { mwaSupported, usableWallet, walletChain } from "./phone-sign";

/** SolanaMobileWalletAdapterWalletName in wallet-standard-mobile (kept here so listing does not load MWA). */
export const MWA_WALLET_NAME = "Mobile Wallet Adapter";

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };
type SignTxFeature = { signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]> };
type SignMsgFeature = { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array; signedMessage: Uint8Array }[]> };

let mwaRegistered: Promise<void> | null = null;

/** Registers Mobile Wallet Adapter into the Wallet Standard registry (once, browser only). */
function ensureMwa(): Promise<void> {
  if (!mwaRegistered) {
    mwaRegistered = import("@solana-mobile/wallet-standard-mobile").then(({ registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler }) => {
      registerMwa({
        appIdentity: { name: "Heirloom", uri: window.location.origin, icon: "icons/icon-192.png" },
        authorizationCache: createDefaultAuthorizationCache(),
        chains: [walletChain(chainConfig.cluster)],
        chainSelector: createDefaultChainSelector(),
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
      });
    });
    mwaRegistered.catch(() => { mwaRegistered = null; });
  }
  return mwaRegistered;
}

const chain = () => walletChain(chainConfig.cluster);
const supportsMwa = () => typeof window !== "undefined" && mwaSupported(navigator.userAgent, window.isSecureContext);

async function findWallet(name: string): Promise<Wallet> {
  if (name === MWA_WALLET_NAME) await ensureMwa();
  const w = getWallets().get().find((x) => x.name === name);
  if (!w || !usableWallet(w, chain())) throw new Error("That wallet is not available on this device any more.");
  return w;
}

async function accountFor(w: Wallet, address: string): Promise<WalletAccount> {
  let acc = w.accounts.find((a) => a.address === address);
  if (!acc) {
    // After a reload the wallet is not connected yet: try a silent reconnect first, then ask.
    const connect = (w.features["standard:connect"] as ConnectFeature).connect;
    await connect({ silent: true }).catch(() => null);
    acc = w.accounts.find((a) => a.address === address);
    if (!acc) acc = (await connect()).accounts.find((a) => a.address === address);
  }
  if (!acc) throw new Error("This phone wallet no longer offers the account Heirloom knows. Open your wallet and pick it again.");
  return acc;
}

export function standardPhoneDriver(): PhoneDriver {
  return {
    async list() {
      const out: PhoneWalletOption[] = [];
      if (supportsMwa()) out.push({ name: MWA_WALLET_NAME, mwa: true, simulated: false });
      for (const w of getWallets().get()) {
        if (w.name === MWA_WALLET_NAME || !usableWallet(w, chain())) continue;
        out.push({ name: w.name, icon: w.icon, mwa: false, simulated: false });
      }
      return out;
    },
    async connect(walletName) {
      const w = await findWallet(walletName);
      const { accounts } = await (w.features["standard:connect"] as ConnectFeature).connect();
      const acc = accounts.find((a) => a.chains.includes(chain())) ?? accounts[0];
      if (!acc) throw new Error("The wallet did not share an account.");
      return { address: acc.address, walletName: w.name };
    },
    async signTransaction(walletName, address, wire) {
      const w = await findWallet(walletName);
      const account = await accountFor(w, address);
      const [out] = await (w.features["solana:signTransaction"] as SignTxFeature).signTransaction({ account, transaction: wire, chain: chain() });
      if (!out?.signedTransaction) throw new Error("The phone wallet did not sign the transaction.");
      return out.signedTransaction;
    },
    async signMessage(walletName, address, message) {
      const w = await findWallet(walletName);
      const account = await accountFor(w, address);
      const [out] = await (w.features["solana:signMessage"] as SignMsgFeature).signMessage({ account, message });
      if (!out?.signature || out.signature.length !== 64) throw new Error("The phone wallet did not sign the message.");
      return out.signature;
    },
    async disconnect(walletName) {
      const w = getWallets().get().find((x) => x.name === walletName);
      const f = w?.features["standard:disconnect"] as DisconnectFeature | undefined;
      await f?.disconnect().catch(() => undefined);
    },
  };
}
