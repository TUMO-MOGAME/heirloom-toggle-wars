/**
 * Chip in on devnet (plan §21): asks a running Heirloom server (chain mode) for a chip-in transaction exactly as a
 * wallet would (Solana Pay transaction request: GET, then POST { account }), checks it, and simulates it on devnet.
 * With --send and a persona, that persona's WDK wallet signs and sends it (devnet only; seeds from the wallets file,
 * CHIPIN_WALLETS or scripts/.demo-wallets.json, never created here and never printed), then the chip-in is looked
 * up by the estate's tag.
 *
 *   npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/chipin-devnet.ts <server> <estate> <amount> <persona|address> [--send]
 */
import { Transaction } from "@solana/web3.js";
import { decodeTransferCheckedInstruction } from "@solana/spl-token";
import { existsSync, readFileSync } from "node:fs";
import { connection, explorer, log, rpcUrl, WALLETS_FILE, type WalletsFile } from "./_shared";
import { openAccount, wdkSignAndSend } from "../app/src/lib/wallet/wdk";
import { chipInTag } from "../app/src/lib/chipin/link";
import { findChipIns } from "../app/src/lib/chipin/find";

const [server, estate, amount, who, flag] = process.argv.slice(2);
if (!server || !estate || !amount || !who) throw new Error("usage: chipin-devnet.ts <server> <estate> <amount> <persona|address> [--send]");
const send = flag === "--send";

async function main() {
  const api = `${server.replace(/\/$/, "")}/api/chipin/${estate}`;
  const meta = await (await fetch(api)).json();
  log(`GET: label "${meta.label}", disabled ${meta.disabled ?? false}`);
  const file = process.env.CHIPIN_WALLETS || WALLETS_FILE;
  const wallets = send || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(who)
    ? (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as WalletsFile) : null)
    : null;
  if ((send || wallets) && wallets?.cluster !== "devnet") throw new Error("Devnet persona wallets only.");
  const account = wallets ? wallets.addresses[who as keyof WalletsFile["addresses"]] : who;
  if (!account) throw new Error(`No persona ${who}`);
  const res = await fetch(`${api}?amount=${encodeURIComponent(amount)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`POST ${res.status}: ${body.message}`);
  log(`POST: ${body.message}`);
  const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
  const d = decodeTransferCheckedInstruction(tx.instructions[0]);
  log(`transfer_checked ${d.data.amount} base units, ${d.data.decimals} dp, to ${d.keys.destination.pubkey.toBase58()}, tag ${d.keys.multiSigners[0].pubkey.toBase58() === chipInTag(estate)}`);
  const conn = connection();
  // Unsigned simulation (no signature check): the same accounts and balances the wallet will see.
  const sim = await conn.simulateTransaction(tx);
  log(`simulation: ${sim.value.err ? JSON.stringify(sim.value.err) : "ok"} (${sim.value.unitsConsumed ?? "?"} CU)`);
  if (!send) return;
  const w = await openAccount(wallets!.seeds[who as keyof WalletsFile["seeds"]], rpcUrl());
  if (w.address !== account) throw new Error("The wallet does not match the persona");
  const sig = await wdkSignAndSend(w.account, body.transaction).finally(() => w.manager.dispose());
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log(`sent: ${explorer(sig)}`);
  const mint = d.keys.mint.pubkey.toBase58();
  for (let i = 0; i < 10; i++) {
    const found = (await findChipIns(conn, estate, mint)).find((x) => x.signature === sig);
    if (found) { log(`found by the estate's tag: ${found.amount} base units from ${found.from}`); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log("not found by the tag yet");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
