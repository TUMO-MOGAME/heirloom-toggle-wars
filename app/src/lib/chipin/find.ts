/**
 * Finds the chip-ins to one vault (Solana Pay's findReference + validateTransfer, for many at once): every
 * transaction that names the estate's tag (lib/chipin/link.ts), checked one by one. Anyone can name the tag, so a
 * transaction counts only if it succeeded and the vault's balance of the configured USD₮ mint went up in it; the
 * amount shown is that rise, read from the network's own token balances, never from the instruction.
 * Runs in the browser (chain service) and in tests with a fake connection.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { vaultAta } from "../chain/pda";
import { explorerTx } from "../format";
import { chipInTag } from "./link";
import type { ChipIn } from "./types";

export type FindConn = Pick<Connection, "getSignaturesForAddress" | "getParsedTransaction">;

/** At most this many shown; at most `scan` signatures read (the free RPC throttles bursts). */
export async function findChipIns(conn: FindConn, estate: string, mint: string, opts: { limit?: number; scan?: number } = {}): Promise<ChipIn[]> {
  const limit = opts.limit ?? 10;
  const tag = new PublicKey(chipInTag(estate));
  const vault = vaultAta(mint, estate).toBase58();
  const sigs = (await conn.getSignaturesForAddress(tag, { limit: opts.scan ?? 20 }, "confirmed")).filter((s) => !s.err);
  const out: ChipIn[] = [];
  for (const s of sigs) {
    if (out.length >= limit) break;
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (!tx?.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    if (!keys.includes(tag.toBase58())) continue;
    const at = keys.indexOf(vault);
    if (at < 0) continue;
    const bal = (list: typeof tx.meta.preTokenBalances) => BigInt(list?.find((b) => b.accountIndex === at && b.mint === mint)?.uiTokenAmount.amount ?? "0");
    const rise = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
    if (rise <= 0n) continue;
    out.push({ signature: s.signature, explorerUrl: explorerTx(s.signature), ts: tx.blockTime ?? s.blockTime ?? 0, amount: rise, from: keys[0] });
  }
  return out;
}
