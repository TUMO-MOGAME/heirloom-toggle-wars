/** SOL and USD₮ of many wallets in one RPC call (it used to be two calls per wallet on every refresh). */
import { PublicKey } from "@solana/web3.js";
import { chainConfig } from "./config";
import { ata } from "./pda";
import { getConnection } from "./tx";

const AMOUNT_OFFSET = 64; // SPL token account: mint 32, owner 32, amount u64 LE

export function tokenAmount(data: Uint8Array | undefined): bigint {
  if (!data || data.length < AMOUNT_OFFSET + 8) return 0n;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[AMOUNT_OFFSET + i]);
  return v;
}

export async function readBalances(addresses: string[]): Promise<Map<string, { lamports: number; usdt: bigint }>> {
  const conn = getConnection();
  const mint = chainConfig.usdtMint;
  const rows = await Promise.all(addresses.map(async (address) => {
    const [wallet, token] = await Promise.all([
      conn.getAccountInfo(new PublicKey(address), "confirmed"),
      mint ? conn.getAccountInfo(ata(mint, address), "confirmed") : Promise.resolve(null),
    ]);
    return [address, { lamports: wallet?.lamports ?? 0, usdt: tokenAmount(token?.data) }] as const;
  }));
  return new Map(rows);
}
