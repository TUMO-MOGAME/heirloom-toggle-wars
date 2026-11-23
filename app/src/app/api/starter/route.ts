import { z } from "zod";
import { clientIp, handler, HttpError, isChainMode, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { verifyAction } from "@/lib/access/server";
import { actionBody } from "@/lib/access/messages";
import { grantStarter } from "@/lib/starter/server";
import { POW, checkProof } from "@/lib/starter/pow";

export const maxDuration = 45;

const body = z.object({
  wallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  proof: z.object({ window: z.number().int().nonnegative(), nonces: z.array(z.number().int().nonnegative()).max(POW.parts) }).optional(),
});

/**
 * POST /api/starter { wallet, proof }, signed by that wallet, with a small proof of work bound to it and the time
 * (lib/starter/pow.ts) → devnet SOL for rent and test USD₮, once. Every refusal has a code, and says when to retry
 * (`retryAfter`, seconds) or points to faucet.solana.com.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "starter-minute", 10);
  if (!isChainMode()) throw new HttpError(503, "The demo needs no starter funds.", "unavailable");
  const { wallet, proof } = await parseJson(req, body, 1_000);
  if ((await verifyAction(req, "starter", wallet, actionBody.starter())) !== wallet) {
    throw new HttpError(403, "A wallet can only ask for itself.", "forbidden");
  }
  if (!proof || !checkProof(wallet, proof)) {
    throw new HttpError(400, "The proof of work is missing or out of date. Reload and try again now.", "proof", 1);
  }
  // Grants are paced per network address too (STARTER.perIpHour, perIpDay), counted only when one is sent.
  return json(await grantStarter(wallet, undefined, clientIp(req)));
});
