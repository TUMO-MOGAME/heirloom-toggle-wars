import "server-only";
/**
 * The AI agent's own Tether WDK wallet (server side, seed from AGENT_SEED_PHRASE). It may sign ONLY
 * review_death, review_claim, review_hardship, review_seat_death, review_fallback_death, list_asset, accept_offer and
 * execute_scheduled (it only pays the fee; the program sends the fixed amount to the rule's fixed payee) for the
 * Heirloom program; every transaction is checked against that allow-list before WDK signs it. It never sets asset
 * photos (the living owner's, R22), never resolves a death and, while a seat has a holder, never sells by itself:
 * it adds its signature to the trusted person's transaction (agentCoSignSale). The program enforces the rest.
 */
import { PublicKey, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import { chainConfig } from "../chain/config";
import { findInstruction, getIdl } from "../chain/idl";
import { prepareTx } from "../chain/client";
import { base64ToBytes, bytesToBase64, confirmOrThrow, getConnection } from "../chain/tx";
import { explainSendError, openAccount, wdkPartialSign, wdkSignAndSend, type WdkAccount } from "../wallet/wdk";
import { explorerTx } from "../format";
import { assertProgram } from "../server/program";

export const AGENT_ALLOWED = [
  "review_death", "review_claim", "review_hardship", "list_asset", "accept_offer", "execute_scheduled",
  // Guardians: the agent's death-certificate reviews for a trusted person's seat and for a fallback recipient.
  "review_seat_death", "review_fallback_death",
] as const;
export type AgentIx = (typeof AGENT_ALLOWED)[number];

let wallet: Promise<WdkAccount> | null = null;

/** The seed with stray whitespace (a trailing CR LF from a Windows paste or pipe) removed. */
const agentSeed = () => process.env.AGENT_SEED_PHRASE?.trim().split(/\s+/).join(" ") || "";
export const hasAgentWallet = () => Boolean(agentSeed());

function agentAccount(): Promise<WdkAccount> {
  const seed = agentSeed();
  if (!seed) throw new Error("AGENT_SEED_PHRASE is not set, so the agent cannot sign on-chain.");
  if (!wallet) wallet = openAccount(seed, process.env.SOLANA_RPC_URL || chainConfig.rpcUrl).catch((e) => { wallet = null; throw e; });
  return wallet;
}

export async function agentAddress(): Promise<string | null> {
  if (!hasAgentWallet()) return null;
  return (await agentAccount()).address;
}

/** Enough for a few hundred fees; below it the agent stops. */
const AGENT_RESERVE_LAMPORTS = 10_000_000;

const eq = (a: Uint8Array, b: number[]) => a.length >= 8 && b.every((x, i) => a[i] === x);

/** Throws unless every instruction targets the Heirloom program with an allow-listed discriminator. */
export function assertAllowed(ixs: TransactionInstruction[]): void {
  const programId = new PublicKey(getIdl().address);
  const names = getIdl().instructions.map((i) => i.name);
  const allowed = AGENT_ALLOWED.filter((n) => names.includes(n)).map((n) => findInstruction(n).discriminator);
  for (const ix of ixs) {
    if (!ix.programId.equals(programId)) throw new Error("Agent may only call the Heirloom program.");
    if (!allowed.some((d) => eq(ix.data, d))) throw new Error("Agent is not allowed to sign this instruction.");
  }
}

/** The backstop against draining: holds across server instances, unlike the per-wallet allowances. */
async function assertReserve(address: string): Promise<void> {
  if ((await getConnection().getBalance(new PublicKey(address), "confirmed")) < AGENT_RESERVE_LAMPORTS) {
    throw new Error("The agent's wallet is low on SOL, so it is not signing right now.");
  }
}

export async function agentSignAndSend(ixs: TransactionInstruction[]): Promise<{ signature: string; explorerUrl: string }> {
  assertAllowed(ixs);
  await assertProgram();
  const acc = await agentAccount();
  await assertReserve(acc.address);
  const b64 = await prepareTx(acc.address, ixs);
  const signature = await wdkSignAndSend(acc.account, b64);
  await confirmOrThrow(signature);
  return { signature, explorerUrl: explorerTx(signature) };
}

/** Throws unless the agent is being asked to pay for exactly one accept_offer. */
export function assertOneSale(tx: Pick<Transaction, "instructions" | "feePayer">, agent: string): void {
  assertAllowed(tx.instructions);
  const accept = findInstruction("accept_offer").discriminator;
  if (tx.instructions.length !== 1 || !eq(tx.instructions[0].data, accept) || tx.feePayer?.toBase58() !== agent) {
    throw new Error("Agent is not allowed to co-sign this.");
  }
}

/**
 * The agent's signature on a sale a trusted person signed. Only ever called after lib/agent/sale.ts accepted the
 * exact bytes; preflight refuses what the program would (OfferChanged) before a fee is paid.
 */
export async function agentCoSignSale(tx: Transaction): Promise<{ signature: string; explorerUrl: string }> {
  const acc = await agentAccount();
  assertOneSale(tx, acc.address);
  await assertProgram();
  await assertReserve(acc.address);
  const partly = bytesToBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const { wireBase64, signature } = await wdkPartialSign(acc.account, partly);
  try {
    await getConnection().sendRawTransaction(base64ToBytes(wireBase64), { preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    throw new Error(explainSendError(e));
  }
  await confirmOrThrow(signature);
  return { signature, explorerUrl: explorerTx(signature) };
}

/**
 * Fee sponsorship: the agent's WDK wallet adds its fee-payer signature to a user's partially signed tx.
 * Only ever called by /api/sponsor AFTER lib/sponsor/policy.ts validated the exact bytes.
 */
export async function agentCoSign(wireBase64: string): Promise<{ wireBase64: string; signature: string }> {
  await assertProgram();
  const acc = await agentAccount();
  return wdkPartialSign(acc.account, wireBase64);
}
