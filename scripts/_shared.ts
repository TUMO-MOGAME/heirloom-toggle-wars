/**
 * Shared helpers for the devnet scripts. Every demo wallet is a Tether WDK wallet; every transaction is
 * signed and sent by WDK (`account.sendTransaction(base64)`), including ones that also need a fresh mint
 * keypair (we partially sign with the mint key first, then WDK adds the fee payer's signature).
 *
 * Seeds are written to scripts/.demo-wallets.json (gitignored). DEVNET ONLY: never put real funds in them.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { openAccount, newSeedPhrase, wdkPartialSign, wdkSignAndSend, type WdkAccount } from "../app/src/lib/wallet/wdk";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const WALLETS_FILE = join(ROOT, ".demo-wallets.json");

/** Loads app/.env.local (if present) so scripts see the same config as the app. */
export function loadEnv(): void {
  const p = join(ROOT, "..", "app", ".env.local");
  if (existsSync(p)) process.loadEnvFile(p);
}

export const rpcUrl = () => process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const connection = () => new Connection(rpcUrl(), "confirmed");

export const PERSONAS = [
  { id: "dad", label: "Thabo Mokoena (dad)", role: "owner" },
  { id: "lerato", label: "Lerato (daughter)", role: "beneficiary" },
  { id: "sipho", label: "Sipho (son)", role: "beneficiary" },
  { id: "naledi", label: "Naledi (daughter)", role: "beneficiary" },
  { id: "ndlovu", label: "Adv. Thandi Ndlovu (executor)", role: "verifier" },
  { id: "pillay", label: "Ms. Anita Pillay (attorney)", role: "verifier" },
  { id: "bongani", label: "Uncle Bongani Mokoena (family)", role: "verifier" },
  { id: "pieter", label: "Pieter (car buyer)", role: "buyer" },
  { id: "ayesha", label: "Ayesha (car buyer)", role: "buyer" },
  { id: "agent", label: "Heirloom AI agent", role: "agent" },
  { id: "uct", label: "University of Cape Town (payee)", role: "payee" },
  { id: "residence", label: "Tugwell Residence (payee)", role: "payee" },
  { id: "school", label: "Westerford High School (payee)", role: "payee" },
  // Added 15 Nov 2026 for the guardians demo estate (scripts/seed-guardians-assets.ts); dad's estate is Unlocked.
  { id: "thabo", label: "Thabo Mokoena (owner of the guardians demo estate)", role: "owner" },
  { id: "zodwa", label: "Aunt Zodwa Mokoena (monitor of Uncle Bongani)", role: "monitor" },
  { id: "kagiso", label: "Cousin Kagiso Mokoena (Uncle Bongani's first backup)", role: "backup" },
  { id: "priya", label: "Adv. Priya Naidoo (Uncle Bongani's second backup)", role: "backup" },
  { id: "charity", label: "Ithemba Children's Charity (last fallback recipient)", role: "payee" },
  // Added 17 Nov 2026: a fresh demo estate (5-minute waiting period, no test rules). One estate per owner wallet.
  { id: "thabo2", label: "Thabo Mokoena (owner of the fresh demo estate, 17 Nov)", role: "owner" },
] as const;
export type PersonaId = (typeof PERSONAS)[number]["id"];

export interface WalletsFile {
  cluster: string;
  seeds: Record<PersonaId, string>;
  addresses: Record<PersonaId, string>;
  usdtMint?: string;
  carMint?: string;
  /** Title NFTs of the guardians demo estate (owner `thabo`): the 2017 Corolla and the motorbike. */
  corollaMint?: string;
  bikeMint?: string;
  /** Title NFTs for other demo owners (e.g. `thabo2`), keyed by owner persona. */
  titlesByOwner?: Record<string, { corollaMint?: string; bikeMint?: string }>;
}

export async function loadOrCreateWallets(): Promise<WalletsFile> {
  const existing = existsSync(WALLETS_FILE) ? (JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as WalletsFile) : null;
  if (existing && PERSONAS.every((p) => existing.seeds[p.id])) return existing;
  const seeds = (existing?.seeds ?? {}) as Record<PersonaId, string>;
  const addresses = (existing?.addresses ?? {}) as Record<PersonaId, string>;
  for (const p of PERSONAS) {
    if (seeds[p.id]) continue; // keep existing wallets, add any new persona
    seeds[p.id] = await newSeedPhrase();
    const acc = await openAccount(seeds[p.id], rpcUrl());
    addresses[p.id] = acc.address;
    acc.manager.dispose();
  }
  const file: WalletsFile = { ...existing, cluster: "devnet", seeds, addresses };
  saveWallets(file);
  return file;
}

export function saveWallets(f: WalletsFile): void {
  writeFileSync(WALLETS_FILE, JSON.stringify(f, null, 2), { mode: 0o600 });
}

const open = new Map<PersonaId, WdkAccount>();
export async function wdk(w: WalletsFile, id: PersonaId): Promise<WdkAccount> {
  let a = open.get(id);
  if (!a) { a = await openAccount(w.seeds[id], rpcUrl()); open.set(id, a); }
  return a;
}
export function disposeAll(): void { open.forEach((a) => a.manager.dispose()); open.clear(); }

/** Builds a tx (fee payer = WDK account), optionally partially signed by extra keypairs, then WDK signs + sends. */
export async function send(payer: WdkAccount, ixs: TransactionInstruction[], extraSigners: Keypair[] = []): Promise<string> {
  const conn = connection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: new PublicKey(payer.address), blockhash, lastValidBlockHeight }).add(...ixs);
  if (extraSigners.length) tx.partialSign(...extraSigners);
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const sig = await wdkSignAndSend(payer.account, b64);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/** Like `send`, for a transaction someone co-signs (a sale: the trusted person, then the agent who pays). */
export async function sendCoSigned(payer: WdkAccount, coSigners: WdkAccount[], ixs: TransactionInstruction[]): Promise<string> {
  const conn = connection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: new PublicKey(payer.address), blockhash, lastValidBlockHeight }).add(...ixs);
  let b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  for (const c of coSigners) b64 = (await wdkPartialSign(c.account, b64)).wireBase64;
  const signed = await wdkPartialSign(payer.account, b64);
  await conn.sendRawTransaction(Buffer.from(signed.wireBase64, "base64"), { maxRetries: 3 });
  await conn.confirmTransaction({ signature: signed.signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signed.signature;
}

export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const log = (msg: string) => console.log(`• ${msg}`);
