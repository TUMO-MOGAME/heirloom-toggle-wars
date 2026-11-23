import "server-only";
/**
 * /api/asks logic (app/api/asks/route.ts re-exports it): GET an estate's request notes, POST a signed note (the asker)
 * or decline (the owner). Kept here with its chain reads injectable, so tests can drive it without a network.
 *
 * GET is for members only, with a read pass (lib/access). POST needs a fresh ed25519 signature from the right wallet, checked against the chain:
 *  - note: the claim exists, belongs to `estate`, and `wallet` is its beneficiary;
 *  - decline: `wallet` owns the estate, the estate is Active and the claim is still Open and not approved.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { handler, HttpError, isChainMode, json, parseJson, rateLimit } from "@/lib/api/http";
import { verifyEd25519 } from "@/lib/legacy/server/auth";
import { fetchAccountRaw } from "@/lib/chain/reads";
import { bool, enumOf, key, num, type Raw } from "@/lib/chain/decoders";
import { ASK_MAX_SKEW_MS, askMessage, noteBody } from "../auth-message";
import { cleanPurpose, PURPOSE_MAX } from "../types";
import { declineAsk, getAsk, listAsks, saveAsk } from "./store";
import { requireMember, type MemberCheck } from "@/lib/access/server";
import { createNonces } from "@/lib/access/nonces";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const sig = z.string().regex(/^[0-9a-f]{128}$/);
const signed = { estate: addr, claim: addr, wallet: addr, ts: z.number().int().positive(), sig };
const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("note"), ...signed,
    purpose: z.string().min(1).max(PURPOSE_MAX * 2), currency: z.enum(["ZAR", "USDT"]), typed: z.number().nonnegative().max(1e9), attachment: z.boolean(),
  }),
  z.object({ action: z.literal("decline"), ...signed }),
]);
export type AskPost = z.infer<typeof body>;

export interface AskRouteDeps {
  member?: MemberCheck;
  fetchRaw(type: "Claim" | "Estate", address: string): Promise<Raw | null>;
  now(): number;
  chain(): boolean;
}
const defaults: AskRouteDeps = { fetchRaw: fetchAccountRaw, now: () => Date.now(), chain: isChainMode };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const firstUse = createNonces("ask", ASK_MAX_SKEW_MS * 2);

export function askRoutes(deps: AskRouteDeps = defaults) {
  const GET = handler(async (req) => {
    rateLimit(req, "asks", 60);
    const estate = addr.parse(new URL(req.url).searchParams.get("estate"));
    await requireMember(req, estate, deps.member);
    return json(await listAsks(estate));
  });

  const POST = handler(async (req) => {
    rateLimit(req, "asks-write", 20);
    if (!deps.chain()) throw new HttpError(503, "The demo keeps requests in the browser.", "unavailable");
    const b = await parseJson(req, body, 10_000);
    const now = deps.now();
    if (Math.abs(now - b.ts) > ASK_MAX_SKEW_MS) throw new HttpError(401, "This request is too old. Please try again.", "stale");
    const purpose = b.action === "note" ? cleanPurpose(b.purpose) : "";
    const hash = b.action === "note" ? sha(noteBody({ purpose, currency: b.currency, typed: b.typed, attachment: b.attachment })) : sha("");
    if (!verifyEd25519(b.wallet, askMessage(b.action, b.estate, b.claim, b.wallet, b.ts, hash), b.sig)) throw new HttpError(401, "The signature does not match this wallet.", "unauthorized");
    if (!(await firstUse(b.sig, now))) throw new HttpError(401, "This request was already used. Please try again.", "replay");

    const claim = await deps.fetchRaw("Claim", b.claim);
    if (!claim) throw new HttpError(404, "That request was not found on-chain.");
    if (key(claim, "estate") !== b.estate) throw new HttpError(400, "That request belongs to another estate.");
    const createdAt = num(claim, "created_at");

    if (b.action === "note") {
      if (key(claim, "beneficiary") !== b.wallet) throw new HttpError(403, "Only the person who asked can describe the request.", "forbidden");
      if (!purpose) throw new HttpError(400, "Say what the money is for.");
      // Once someone decided on the request, what it is for can't be rewritten under them.
      const status = enumOf(claim, "status", ["Open", "Paid", "Rejected"] as const);
      const approvals = "approvals" in claim ? num(claim, "approvals") : 0;
      const held = await getAsk(b.claim);
      if (status === "Paid" || bool(claim, "owner_approved") || approvals !== 0 || (held?.purpose && (held.declinedAt !== null || status !== "Open"))) {
        throw new HttpError(409, "This request is already decided, so what it is for can't be changed.", "decided");
      }
      await saveAsk({ estate: b.estate, claim: b.claim, purpose, currency: b.currency, typed: b.typed, attachment: b.attachment, createdAt, declinedAt: null });
      return json({ ok: true });
    }

    const estate = await deps.fetchRaw("Estate", b.estate);
    if (!estate) throw new HttpError(404, "Estate not found on-chain.");
    if (key(estate, "owner") !== b.wallet) throw new HttpError(403, "Only the estate owner can say no to a request.", "forbidden");
    if (enumOf(estate, "status", ["Active", "DeathPending", "Unlocked", "Frozen"] as const) !== "Active") throw new HttpError(409, "Only the owner decides, and only while the estate is active.", "BadStatus");
    if (enumOf(claim, "status", ["Open", "Paid", "Rejected"] as const) !== "Open" || bool(claim, "owner_approved")) throw new HttpError(409, "This request is already decided.", "BadStatus");
    const at = Math.floor(now / 1000);
    await declineAsk(b.estate, b.claim, at, createdAt);
    return json({ ok: true, declinedAt: at, note: await getAsk(b.claim) });
  });

  return { GET, POST };
}
