#!/usr/bin/env node
// Heirloom's upgrade authority on devnet is a Squads v4 multisig: 2 of 3 members must approve, and an approved
// upgrade waits out a time lock before anyone can execute it. This script is the only way to upgrade the program.
//
//   node squads.mjs create  --creator <keypair> --members <k1>,<k2>,<k3>   make the multisig, print its vault
//   node squads.mjs propose --member <keypair> --buffer <address>          propose "upgrade the program from this buffer"
//        [--dry-run] simulate the vault's upgrade message and stop (nothing is sent; the vault needs a little SOL)
//   Grow the program first if the new binary is bigger: `solana program extend <program> <bytes>` (on devnet
//   ExtendProgramChecked is not active yet, so the plain extend needs no authority; checked 25 Nov 2026).
//   node squads.mjs approve --member <keypair> --index <n>                 approve proposal n
//   node squads.mjs execute --member <keypair> --index <n>                 run proposal n after the time lock
//   node squads.mjs propose-tx --member <keypair> --tx <base64|base58> [--memo text]  wrap a vault-signed transaction
//   node squads.mjs show                                                   print the multisig, vault and authority
//
// Keypairs are Solana CLI JSON files; they are read, never printed. The multisig's address is kept in
// multisig.json next to this script (public data only). Devnet only: the RPC's genesis hash is checked.
// To upgrade: build, `solana program write-buffer target/deploy/heirloom.so`, then
// `solana program set-buffer-authority <buffer> --new-buffer-authority <vault>`, then propose, approve twice, execute.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as multisig from "@sqds/multisig";
import {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage,
  SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const THRESHOLD = 2;
const TIME_LOCK_SECS = 600; // 10 minutes on devnet: anyone can see an upgrade coming before it runs
const STATE = join(dirname(fileURLToPath(import.meta.url)), "multisig.json");
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

const die = (msg) => { console.error(`!! ${msg}`); process.exit(1); };
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const need = (name) => arg(name) ?? die(`--${name} is required`);
const keypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const state = () => existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : die("no multisig.json: run create first");
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const connection = new Connection(RPC, "confirmed");
if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) die("this RPC is not devnet");

async function confirm(sig) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) die(`transaction failed: ${JSON.stringify(res.value.err)} ${explorer(sig)}`);
  console.log(`   ${explorer(sig)}`);
}

function programData() {
  return PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER)[0];
}

async function upgradeAuthority() {
  const info = await connection.getAccountInfo(programData());
  if (!info) die("program data account not found");
  // UpgradeableLoaderState::ProgramData: u32 tag, u64 slot, Option<Pubkey> authority.
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)).toBase58() : "none (frozen)";
}

const cmd = process.argv[2];

if (cmd === "create") {
  if (existsSync(STATE)) die("multisig.json exists: a multisig was already created");
  const creator = keypair(need("creator"));
  const members = need("members").split(",").map((p) => keypair(p).publicKey);
  if (members.length !== 3 || new Set(members.map(String)).size !== 3) die("give three different members");
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  console.log("== create a 2-of-3 Squads v4 multisig on devnet");
  const sig = await multisig.rpc.multisigCreateV2({
    connection, treasury: programConfig.treasury, createKey, creator, multisigPda,
    configAuthority: null, // autonomous: its own members change it, through the same 2-of-3 vote
    threshold: THRESHOLD, timeLock: TIME_LOCK_SECS, rentCollector: null,
    members: members.map((key) => ({ key, permissions: multisig.types.Permissions.all() })),
    sendOptions: { skipPreflight: false },
  });
  await confirm(sig);
  writeFileSync(STATE, JSON.stringify({
    cluster: "devnet", multisig: multisigPda.toBase58(), vault: vault.toBase58(), threshold: THRESHOLD,
    timeLockSecs: TIME_LOCK_SECS, members: members.map(String), createdTx: sig,
  }, null, 2) + "\n");
  console.log(`   multisig ${multisigPda.toBase58()}\n   vault    ${vault.toBase58()} (make this the upgrade authority)`);
} else if (cmd === "propose") {
  const s = state();
  const member = keypair(need("member"));
  const buffer = new PublicKey(need("buffer"));
  const multisigPda = new PublicKey(s.multisig);
  const vault = new PublicKey(s.vault);
  if ((await upgradeAuthority()) !== s.vault) die("the multisig vault is not the program's upgrade authority");
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const transactionIndex = BigInt(info.transactionIndex.toString()) + 1n;
  // BPF upgradeable loader Upgrade (tag 3). Spill (leftover buffer rent) goes to the proposer.
  const upgrade = new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programData(), isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: member.publicKey, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([3, 0, 0, 0]),
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const transactionMessage = new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: [upgrade] });
  if (process.argv.includes("--dry-run")) {
    // Simulate the vault's own message without checking signatures, and stop: nothing is sent. The vault pays the
    // simulated fee, so it needs a little SOL.
    const { VersionedTransaction } = await import("@solana/web3.js");
    const sim = await connection.simulateTransaction(new VersionedTransaction(transactionMessage.compileToV0Message()),
      { sigVerify: false, replaceRecentBlockhash: true });
    console.log(JSON.stringify({ err: sim.value.err, units: sim.value.unitsConsumed, logs: sim.value.logs?.slice(-6) }, null, 2));
    process.exit(sim.value.err ? 1 : 0);
  }
  console.log(`== propose upgrade #${transactionIndex} from buffer ${buffer.toBase58()}`);
  await confirm(await multisig.rpc.vaultTransactionCreate({
    connection, feePayer: member, multisigPda, transactionIndex, creator: member.publicKey, vaultIndex: 0,
    ephemeralSigners: 0, transactionMessage, memo: "Heirloom program upgrade",
  }));
  await confirm(await multisig.rpc.proposalCreate({ connection, feePayer: member, creator: member, multisigPda, transactionIndex }));
  console.log(`   proposal ${transactionIndex}: needs ${s.threshold} approvals, then a ${s.timeLockSecs} s time lock`);
} else if (cmd === "propose-tx") {
  // Wrap a transaction the vault must sign (e.g. `solana-verify export-pda-tx … --encoding base64`) in a proposal.
  const s = state();
  const member = keypair(need("member"));
  const raw = need("tx");
  const multisigPda = new PublicKey(s.multisig);
  const vault = new PublicKey(s.vault);
  const bytes = /^[A-Za-z0-9+/]+=*$/.test(raw) && raw.length % 4 === 0 ? Buffer.from(raw, "base64") : (await import("bs58")).default.decode(raw);
  const { Transaction } = await import("@solana/web3.js");
  const tx = Transaction.from(bytes);
  const signers = new Set(tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  if ([...signers].some((k) => k !== s.vault)) die("every signer in the transaction must be the multisig vault");
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const transactionIndex = BigInt(info.transactionIndex.toString()) + 1n;
  const { blockhash } = await connection.getLatestBlockhash();
  const transactionMessage = new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: tx.instructions });
  console.log(`== propose #${transactionIndex}: ${tx.instructions.length} instruction(s) signed by the vault`);
  await confirm(await multisig.rpc.vaultTransactionCreate({
    connection, feePayer: member, multisigPda, transactionIndex, creator: member.publicKey, vaultIndex: 0,
    ephemeralSigners: 0, transactionMessage, memo: arg("memo") ?? "Heirloom vault transaction",
  }));
  await confirm(await multisig.rpc.proposalCreate({ connection, feePayer: member, creator: member, multisigPda, transactionIndex }));
  console.log(`   proposal ${transactionIndex}: needs ${s.threshold} approvals, then a ${s.timeLockSecs} s time lock`);
} else if (cmd === "approve" || cmd === "execute") {
  const s = state();
  const member = keypair(need("member"));
  const transactionIndex = BigInt(need("index"));
  const multisigPda = new PublicKey(s.multisig);
  if (cmd === "approve") {
    console.log(`== approve proposal ${transactionIndex}`);
    await confirm(await multisig.rpc.proposalApprove({ connection, feePayer: member, member, multisigPda, transactionIndex }));
  } else {
    console.log(`== execute proposal ${transactionIndex}`);
    await confirm(await multisig.rpc.vaultTransactionExecute({
      connection, feePayer: member, multisigPda, transactionIndex, member: member.publicKey,
    }));
  }
} else if (cmd === "show") {
  const s = state();
  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, new PublicKey(s.multisig));
  console.log(JSON.stringify({
    multisig: s.multisig, vault: s.vault, threshold: info.threshold, timeLockSecs: info.timeLock,
    members: info.members.map((m) => m.key.toBase58()), proposals: info.transactionIndex.toString(),
    programUpgradeAuthority: await upgradeAuthority(),
  }, null, 2));
} else {
  die("usage: node squads.mjs create|propose|approve|execute|show (see the top of this file)");
}
