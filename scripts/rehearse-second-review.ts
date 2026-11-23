/**
 * Rehearses the second security review on devnet, on throwaway estates (the demo estates are never touched): a living
 * claim, a death to payout, a co-signed sale, and the refusals R1-R9 and R18-R20 (scripts/_rehearsal.ts).
 *
 * DRY RUN BY DEFAULT: it checks the cluster and prints the plan; it reads no keypair and sends nothing. `--send` runs
 * it: about five minutes (real waiting periods) and 0.6 SOL in the payer, most of which comes back. Any cluster but
 * devnet is refused, by its genesis hash. It prints JSON with an Explorer link for each transaction, the refused
 * ones too, and exits 1 if any assertion fails. It loads no env file.
 *
 * Run from app/, after the program upgrade:
 *   npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/rehearse-second-review.ts <payer keypair path> [--send] [--rpc <url>]
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { DEVNET_PROGRAM_ID } from "../app/src/lib/chain/config";
import { getIdl } from "../app/src/lib/chain/idl";
import { assertDevnet, rehearsalArgs } from "./_rehearsal-cli";
import { REHEARSAL_MIN_LAMPORTS, REHEARSAL_PLAN, rehearse } from "./_rehearsal";

async function main() {
  const { keypairPath, send, rpc } = rehearsalArgs(process.argv.slice(2));
  const conn = new Connection(rpc, "confirmed");
  await assertDevnet(conn);
  const program = getIdl().address;
  if (program !== DEVNET_PROGRAM_ID) throw new Error("The program id is not Heirloom's devnet program. Nothing was sent.");

  if (!send) {
    console.log(JSON.stringify({
      mode: "dry-run", cluster: "devnet", program, payerKeypair: "not read", payerNeedsSol: REHEARSAL_MIN_LAMPORTS / 1e9,
      plan: REHEARSAL_PLAN, next: "add --send to run it",
    }, null, 2));
    return;
  }
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]));
  const result = await rehearse({
    conn, payer,
    explorer: (signature) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    log: (line) => console.error(`• ${line}`),
  });
  console.log(JSON.stringify({ mode: "send", cluster: "devnet", program, ...result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((e) => {
  // Never an RPC URL: it can carry a key.
  console.error((e instanceof Error ? e.message : String(e)).replace(/(https?|wss?):\/\/\S+/g, "[url]"));
  process.exitCode = 1;
});
