/**
 * Single seam between the UI and the wallet layer: the UI imports the wallet from here only.
 * Backed by the Tether WDK implementation (mock mode: fixed demo personas), with phone wallets
 * (Wallet Standard / Mobile Wallet Adapter) behind the same interface.
 */
export { useWallet, WalletProvider, type RequestPin, type PinReason } from "../wallet/context";
export { usePhoneWallets } from "../wallet/use-phone-wallets";
export type { PhoneWalletOption } from "../wallet/phone";
