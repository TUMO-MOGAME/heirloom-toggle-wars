import "server-only";
/**
 * Server side of fee sponsorship: policy from env, sponsor status, and validate → simulate → co-sign → (submit).
 * The sponsor is the AI agent's Tether WDK wallet (lib/agent/agent-wallet.ts), funded with devnet SOL.
 *
 * Env (all optional):
 *  SPONSOR_ENABLED=0               turn sponsorship off (default on whenever AGENT_SEED_PHRASE is set)
 *  SPONSOR_MAX_FEE_LAMPORTS=20000  max network fee per sponsored tx
 *  SPONSOR_PAYS_RENT=1             sponsor pays rent for the recipient's new USD₮ account (0 = sender pays)
 *  SPONSOR_DAILY_BUDGET_LAMPORTS   fees + rent a day (default 0.3 SOL), across instances with the shared store;
 *                                  without it per instance, and the agent's backstop (agent/budget.ts) caps it too
 *  SPONSOR_MIN_BALANCE_LAMPORTS    stop sponsoring below this sponsor balance (default 0.02 SOL)
 */
import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { agentAddress, agentCoSign, hasAgentWallet } from "../agent/agent-wallet";
import { chainConfig } from "../chain/config";
import { findInstruction, getIdl } from "../chain/idl";
import { base64ToBytes, getConnection } from "../chain/tx";
import { programFailure } from "../chain/program-errors";
import { chainBackstop } from "../agent/budget";
import { takeShared } from "../server/shared-store";
import { assertProgram, programProblem } from "../server/program";
import { RELEASE_WORDS } from "../chain/release";
import { DEFAULT_LIMITS, SPONSOR_RENT_PAYER_ACCOUNTS, SPONSORED_HEIRLOOM_IXS, SponsorRejection, validateSponsoredTx, type SponsorDecision, type SponsorPolicy } from "./policy";
import { DEFAULT_SPONSOR_LIMITS, SponsorLimiter, sharedTakes, type SponsorLimits } from "./limits";

const envInt = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? Math.floor(v) : dflt;
};

export const sponsorEnabled = () => hasAgentWallet() && process.env.SPONSOR_ENABLED !== "0" && Boolean(chainConfig.usdtMint);
export const minSponsorBalance = () => envInt("SPONSOR_MIN_BALANCE_LAMPORTS", 20_000_000);

let limiter: SponsorLimiter | null = null;
function getLimiter(): SponsorLimiter {
  if (!limiter) limiter = new SponsorLimiter(sponsorLimits());
  return limiter;
}

function sponsorLimits(): SponsorLimits {
  return { ...DEFAULT_SPONSOR_LIMITS, dailyBudgetLamports: envInt("SPONSOR_DAILY_BUDGET_LAMPORTS", DEFAULT_SPONSOR_LIMITS.dailyBudgetLamports) };
}

/** Each sponsored Heirloom instruction's signer accounts and estate account, by the IDL. */
export function heirloomAccounts(): Record<string, { signers: number[]; estate: number }> {
  return Object.fromEntries(getIdl().instructions.map((ix) => [ix.name, {
    signers: ix.accounts.flatMap((a, i) => ("signer" in a && a.signer ? [i] : [])),
    estate: ix.accounts.findIndex((a) => a.name === "estate"),
  }]));
}

/**
 * One sponsored transaction from every allowance, or none: this instance's, then the shared ones, else (no shared
 * store) the backstop read from the chain, as for the agent's own signatures. Always await it.
 */
async function spendSponsorAllowance(who: string[], cost: number, rent: boolean, maxFeeLamports: number, ip?: string, now = Date.now()): Promise<void> {
  const lim = getLimiter();
  const limited = lim.check(who, cost, rent, now, ip);
  if (limited) throw new SponsorLimited(limited);
  lim.record(who, cost, rent, now, ip); // before any await, so requests arriving together can't all pass
  try {
    const taken = await takeShared(sharedTakes(who, rent, sponsorLimits(), maxFeeLamports, ip));
    if (!taken) await chainBackstop(now);
    else if (!taken.ok) throw new SponsorLimited("The fee sponsor's limit for now is used up. Please try again later.");
  } catch (e) {
    lim.refund(who, cost, rent, now, ip);
    throw e;
  }
}

/** Who a sponsored transaction is charged to: every signer, and the estate of any permissionless instruction. */
export const chargedTo = (d: Pick<SponsorDecision, "signers" | "cranks">): string[] => [...d.signers, ...d.cranks.map((e) => `estate:${e}`)];

export async function sponsorPolicy(): Promise<SponsorPolicy> {
  const sponsor = await agentAddress();
  if (!sponsor) throw new SponsorUnavailable("The fee sponsor is not configured.");
  const names = getIdl().instructions.map((i) => i.name);
  const heirloomDiscriminators = Object.fromEntries(
    SPONSORED_HEIRLOOM_IXS.filter((n) => names.includes(n)).map((n) => [n, findInstruction(n).discriminator]),
  );
  return {
    sponsor: new PublicKey(sponsor),
    usdtMint: new PublicKey(chainConfig.usdtMint),
    usdtDecimals: 6,
    heirloomProgram: new PublicKey(getIdl().address),
    heirloomDiscriminators,
    ...DEFAULT_LIMITS,
    maxFeeLamports: envInt("SPONSOR_MAX_FEE_LAMPORTS", DEFAULT_LIMITS.maxFeeLamports),
    sponsorPaysRent: process.env.SPONSOR_PAYS_RENT !== "0",
    heirloomRentPayerSlots: rentPayerSlots(),
    heirloomAccounts: heirloomAccounts(),
  };
}

/** Account index of each SPONSOR_RENT_PAYER_ACCOUNTS entry in the current IDL (skipped when absent). */
export function rentPayerSlots(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ixName, account] of Object.entries(SPONSOR_RENT_PAYER_ACCOUNTS)) {
    const ix = getIdl().instructions.find((i) => i.name === ixName);
    const at = ix?.accounts.findIndex((a) => a.name === account) ?? -1;
    if (at >= 0) out[ixName] = at;
  }
  return out;
}

export class SponsorUnavailable extends Error { constructor(m: string) { super(m); this.name = "SponsorUnavailable"; } }

export interface SponsorInfo { available: boolean; feePayer: string | null; maxFeeLamports: number; paysRent: boolean; reason?: string }

/** Public info for the client: whether fees are sponsored and by which address. Never throws. */
export async function sponsorInfo(conn: Connection = getConnection()): Promise<SponsorInfo & { balanceLamports: number | null }> {
  const off = (reason: string, feePayer: string | null = null, balanceLamports: number | null = null) =>
    ({ available: false, feePayer, maxFeeLamports: 0, paysRent: false, reason, balanceLamports });
  if (!sponsorEnabled()) return off("Fee sponsorship is not configured.");
  const problem = await programProblem();
  if (problem) return off(`Not sponsoring: ${RELEASE_WORDS[problem]}.`);
  try {
    const policy = await sponsorPolicy();
    const bal = await conn.getBalance(policy.sponsor, "confirmed");
    if (bal < minSponsorBalance()) return off("The fee sponsor is low on SOL.", policy.sponsor.toBase58(), bal);
    return { available: true, feePayer: policy.sponsor.toBase58(), maxFeeLamports: policy.maxFeeLamports, paysRent: policy.sponsorPaysRent, balanceLamports: bal };
  } catch (e) {
    return off(e instanceof Error ? e.message : "Sponsor unavailable.");
  }
}

export interface SponsorResult { signature: string; wireBase64: string; feeLamports: number; rentLamports: number; submitted: boolean }

/**
 * Validates the partially signed tx, checks limits and the sponsor's balance, simulates it (a failing tx still
 * costs the fee payer), then co-signs with the sponsor's WDK wallet. With `submit`, also broadcasts it.
 * The pay-once client uses submit=false: it stores the fully signed bytes first, then broadcasts them itself.
 */
export async function sponsorTransaction(wireBase64: string, opts: { submit: boolean; ip?: string }, conn: Connection = getConnection()): Promise<SponsorResult> {
  if (!sponsorEnabled()) throw new SponsorUnavailable("Fee sponsorship is not configured.");
  await assertProgram();
  const policy = await sponsorPolicy();
  let wire: Uint8Array;
  try { wire = base64ToBytes(wireBase64); } catch { throw new SponsorRejection("malformed", "Transaction must be base64."); }
  const decision = validateSponsoredTx(wire, policy);
  const who = chargedTo(decision);
  const cost = decision.feeLamports + decision.rentLamports;

  // Cheap, before any RPC call; the allowance itself is taken once the transaction is known to work.
  const limited = getLimiter().check(who, cost, decision.rentLamports > 0, Date.now(), opts.ip);
  if (limited) throw new SponsorLimited(limited);

  const bal = await conn.getBalance(policy.sponsor, "confirmed");
  if (bal - cost < minSponsorBalance()) throw new SponsorUnavailable("The fee sponsor is low on SOL.");

  const sim = await conn.simulateTransaction(VersionedTransaction.deserialize(wire), { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }).catch((e: unknown) => {
    throw new SponsorRejection("malformed", `Could not simulate: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (sim.value.err) {
    const why = programFailure(sim.value.logs ?? []) ?? programFailure(JSON.stringify(sim.value.err));
    const msg = why ? `Rejected by the Heirloom program: ${why}` : `Simulation failed: ${JSON.stringify(sim.value.err)}`;
    throw new SimulationFailed(msg);
  }

  await spendSponsorAllowance(who, cost, decision.rentLamports > 0, policy.maxFeeLamports, opts.ip);
  const { wireBase64: full, signature } = await agentCoSign(wireBase64);
  let submitted = false;
  if (opts.submit) {
    await conn.sendRawTransaction(base64ToBytes(full), { skipPreflight: true, maxRetries: 3 });
    submitted = true;
  }
  return { signature, wireBase64: full, feeLamports: decision.feeLamports, rentLamports: decision.rentLamports, submitted };
}

export class SponsorLimited extends Error { constructor(m: string) { super(m); this.name = "SponsorLimited"; } }
export class SimulationFailed extends Error { constructor(m: string) { super(m); this.name = "SimulationFailed"; } }
