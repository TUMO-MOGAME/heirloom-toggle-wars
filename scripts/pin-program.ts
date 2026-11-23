/**
 * The release step of plan §18.9 C1, run by the lead after the program upgrade and before the push:
 *
 *   cd app && npx --no-install tsx --tsconfig ../scripts/tsconfig.json ../scripts/pin-program.ts [path/to/heirloom.so]
 *
 * Read-only: it reads the program's ProgramData account from devnet (or SOLANA_RPC_URL), checks that it holds exactly
 * the built binary (default target/deploy/heirloom.so), and only then writes app/src/lib/chain/release.json: the slot
 * of that deployment and the hash of the app's IDL. Commit that file with the release. Until it is written, the app's
 * writes and /api/health fail closed on chain sites. No key, wallet or .env file is read.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { RELEASE, pinFor, programDataAddress } from "../app/src/lib/chain/release";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const binaryPath = process.argv[2] ?? join(ROOT, "target/deploy/heirloom.so");
const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

async function main() {
  const binary = new Uint8Array(readFileSync(binaryPath));
  const binarySha256 = createHash("sha256").update(binary).digest("hex");
  const conn = new Connection(rpc, "confirmed");
  const programData = await conn.getAccountInfo(programDataAddress(new PublicKey(RELEASE.programId)), "confirmed");
  const pin = await pinFor({ cluster: RELEASE.cluster, programData, binary, binarySha256 });
  const file = join(ROOT, "app/src/lib/chain/release.json");
  const note = JSON.parse(readFileSync(file, "utf8"))["//"];
  writeFileSync(file, `${JSON.stringify({ "//": note, ...pin }, null, 2)}\n`);
  console.log(`Pinned ${pin.programId} on ${pin.cluster}: deployed in slot ${pin.deploySlot}, ${pin.binaryBytes} bytes, sha256 ${binarySha256}.`);
  console.log(`IDL sha256 ${pin.idlSha256}. Commit app/src/lib/chain/release.json with the release.`);
}

main().catch((e) => { console.error(`!! ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
