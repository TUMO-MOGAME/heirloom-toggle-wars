import { PublicKey } from "@solana/web3.js";
import { handler, json, rateLimit } from "@/lib/api/http";
import { agentAddress } from "@/lib/agent/agent-wallet";
import { hasGemini } from "@/lib/agent/gemini";
import { chainConfig } from "@/lib/chain/config";
import { getIdl } from "@/lib/chain/idl";
import { APP_BUILD, RELEASE } from "@/lib/chain/release";
import { getConnection } from "@/lib/chain/tx";
import { programProblem } from "@/lib/server/program";
import { sponsorInfo } from "@/lib/sponsor/server";

export const maxDuration = 20;

const withTimeout = <T,>(p: Promise<T>, ms = 6_000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * GET /api/health → deployment self-check (public; no secrets, only booleans and public addresses):
 * { ok, mode, cluster, programId, programDeployed, programCurrent, programProblem, release, build, usdtMint, agentWallet,
 *   agentWalletSol, sponsorAvailable, gemini, elevenlabs, supabase }.
 * ok = the program is deployed, RPC answers and, in chain mode, the deployed program is the one this build was made
 * for (lib/chain/release.ts). Not ok in chain mode answers 503, so a monitor sees it.
 */
export const GET = handler(async (req) => {
  rateLimit(req, "health", 30);
  const conn = getConnection();
  const programId = getIdl().address;
  const chain = chainConfig.dataMode === "chain";
  const [program, agent, problem] = await Promise.all([
    withTimeout(conn.getAccountInfo(new PublicKey(programId), "confirmed")).then((a) => Boolean(a?.executable)).catch(() => null),
    agentAddress().catch(() => null),
    withTimeout(programProblem()).catch(() => "unreadable" as const),
  ]);
  const [agentLamports, sponsor] = await Promise.all([
    agent ? withTimeout(conn.getBalance(new PublicKey(agent), "confirmed")).catch(() => null) : Promise.resolve(null),
    withTimeout(sponsorInfo(conn)).catch(() => ({ available: false })),
  ]);
  const ok = program === true && (!chain || problem === null);
  return json({
    ok,
    mode: chainConfig.dataMode,
    cluster: chainConfig.cluster,
    programId,
    programDeployed: program,
    programCurrent: problem === null,
    programProblem: problem,
    release: { deploySlot: RELEASE.deploySlot, idlSha256: RELEASE.idlSha256 },
    build: APP_BUILD,
    usdtMint: chainConfig.usdtMint || null,
    agentWallet: agent,
    agentWalletSol: agentLamports === null ? null : agentLamports / 1e9,
    sponsorAvailable: sponsor.available,
    gemini: hasGemini(),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID),
    supabase: Boolean((process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL) && process.env.SUPABASE_SERVICE_ROLE_KEY),
    time: new Date().toISOString(),
  }, { status: chain && !ok ? 503 : 200 });
});
