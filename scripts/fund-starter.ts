/**
 * Stocks the starter funds (app/src/lib/starter, plan.md §17 A1): tops the agent's wallet up to `--target` test USD₮
 * (default 20,000: 40 grants of 500). Minted by the demo mint authority (persona `dad`), like devnet-setup.ts.
 * The agent's SOL is topped up separately from the deployer (`solana transfer`, see scripts/README.md).
 *
 * DEVNET ONLY. DRY RUN BY DEFAULT: add `--send` to send. Idempotent: it mints only what is missing.
 * Run from app/: npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/fund-starter.ts [--target 20000] [--send]
 */
import { existsSync, readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { WALLETS_FILE, connection, disposeAll, explorer, log, send, wdk, type WalletsFile } from "./_shared";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

async function main() {
  if (!existsSync(WALLETS_FILE)) throw new Error("No demo wallets on this machine (scripts/.demo-wallets.json).");
  const w = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as WalletsFile;
  if (!w.usdtMint) throw new Error("No test USD₮ mint recorded. Run devnet-setup.ts first.");
  const conn = connection();
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("This RPC is not devnet. Nothing sent.");

  const at = process.argv.indexOf("--target");
  const target = Number(at >= 0 ? process.argv[at + 1] : 20_000);
  if (!Number.isInteger(target) || target <= 0 || target > 100_000) throw new Error("--target must be 1 to 100000.");

  const mint = new PublicKey(w.usdtMint);
  const [agent, authority] = [new PublicKey(w.addresses.agent), new PublicKey(w.addresses.dad)];
  const to = getAssociatedTokenAddressSync(mint, agent);
  const have = await conn.getTokenAccountBalance(to).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  const need = BigInt(target) * 1_000_000n - have;

  log(`mint ${mint.toBase58()} · agent ${agent.toBase58()} · holds ${Number(have) / 1e6} test USD₮, ${(await conn.getBalance(agent)) / 1e9} SOL`);
  if (need <= 0n) return log("Already stocked: nothing to send.");
  if (!process.argv.includes("--send")) return log(`DRY RUN: would mint ${Number(need) / 1e6} test USD₮ to the agent, signed by ${authority.toBase58()}. Add --send.`);

  const sig = await send(await wdk(w, "dad"), [
    createAssociatedTokenAccountIdempotentInstruction(authority, to, agent, mint),
    createMintToCheckedInstruction(mint, to, authority, need, 6),
  ]);
  log(`Minted ${Number(need) / 1e6} test USD₮ to the agent ${explorer(sig)}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(disposeAll);
