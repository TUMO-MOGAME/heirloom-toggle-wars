/**
 * Chip in (plan §21): a Solana Pay transaction request and a Solana Action (blink) on one endpoint.
 *   GET  /api/chipin/<estate>                     → { label, icon } (Solana Pay) + the Actions metadata
 *   POST /api/chipin/<estate>?amount=50[&reference=<key>]  { account } → { type: "transaction", transaction, message }
 *   OPTIONS                                       → CORS preflight (Actions clients call from their own origin)
 * Public and unauthenticated by design: it only ever builds an unsigned transfer from the caller's own wallet into
 * the vault. Nothing is signed here and the fee sponsor is not used. Errors are ActionError JSON ({ message }).
 */
import { z } from "zod";
import { HttpError, isChainMode, rateLimit, rateLimitShared } from "@/lib/api/http";
import { chainConfig } from "@/lib/chain/config";
import { getConnection } from "@/lib/chain/tx";
import { actionHeaders, chipInGet, chipInPost } from "@/lib/chipin/actions";
import { buildChipIn, chipInTarget, ChipInError, CHIP_IN_ERRORS } from "@/lib/chipin/build";
import { isAddress, newReference } from "@/lib/chipin/link";

const headers = () => actionHeaders(chainConfig.cluster);
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: headers() });

function fail(e: unknown): Response {
  if (e instanceof ChipInError) return reply({ message: e.message, code: e.code }, e.status);
  if (e instanceof HttpError) {
    const res = reply({ message: e.message, code: e.code }, e.status);
    if (e.retryAfterSecs !== undefined) res.headers.set("retry-after", String(e.retryAfterSecs));
    return res;
  }
  if (e instanceof z.ZodError) return reply({ message: CHIP_IN_ERRORS.bad_account, code: "bad_account" }, 400);
  console.error("[chipin]", e instanceof Error ? e.message : e);
  return reply({ message: "The network could not be reached. Try again in a moment.", code: "server" }, 502);
}

const body = z.object({
  account: z.string().max(64),
  // Actions clients may also send parameter values here.
  data: z.object({ amount: z.union([z.string().max(32), z.array(z.string().max(32)).max(1)]).optional() }).partial().optional(),
}).passthrough();

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: headers() });
}

export async function GET(req: Request, ctx: { params: Promise<{ estate: string }> }): Promise<Response> {
  try {
    rateLimit(req, "chipin-get", 60);
    const { estate } = await ctx.params;
    if (!isAddress(estate)) throw new ChipInError("bad_estate", 404);
    const origin = new URL(req.url).origin;
    if (!isChainMode()) return reply(chipInGet({ origin, estate, cluster: chainConfig.cluster, demo: true, problem: CHIP_IN_ERRORS.demo }));
    let problem: string | null = null;
    try { await chipInTarget(getConnection(), estate, chainConfig.usdtMint); } catch (e) {
      if (!(e instanceof ChipInError)) throw e;
      if (e.code === "bad_estate") throw e;
      problem = e.message;
    }
    return reply(chipInGet({ origin, estate, cluster: chainConfig.cluster, problem }));
  } catch (e) { return fail(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ estate: string }> }): Promise<Response> {
  try {
    await rateLimitShared(req, "chipin-post", 20);
    const { estate } = await ctx.params;
    if (!isChainMode()) throw new ChipInError("demo", 403);
    const text = await req.text();
    if (text.length > 2_000) throw new HttpError(413, "Request too large", "too_large");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new ChipInError("bad_account"); }
    const { account, data } = body.parse(raw);
    const q = new URL(req.url).searchParams;
    const fromData = Array.isArray(data?.amount) ? data.amount[0] : data?.amount;
    const built = await buildChipIn(getConnection(), {
      estate, account, amount: q.get("amount") ?? fromData ?? null, reference: q.get("reference"),
      expectMint: chainConfig.usdtMint, cluster: chainConfig.cluster, newReference,
    });
    return reply(chipInPost(built.transaction, built.message));
  } catch (e) { return fail(e); }
}
