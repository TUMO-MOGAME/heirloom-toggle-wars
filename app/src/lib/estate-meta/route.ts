import "server-only";
/**
 * /api/estate-meta (app/api/estate-meta/route.ts re-exports it): an estate's off-chain display names.
 *
 * GET ?estate=… gives the names to the family only (a read pass, lib/access). Anyone else gets the titles of the
 * things for sale, with every name replaced by its role. GET with no estate says whether names outlast a restart here:
 * { durable }.
 *
 * POST is signed by the acting wallet (ed25519 over lib/estate-meta/signed.ts metaMessage). Checks, in order: the
 * body's shape (400 bad_input) and size (413); the demo deployment (503 unavailable: the demo keeps names in the
 * browser); the time, at most 5 minutes off (401 stale); the signature (401 unauthorized); single use, across
 * instances when the shared store is there (401 replay); the estate from the chain (404 not_found). Then:
 *  - save: only the estate's on-chain owner (403 forbidden); a save older than the last one this instance stored is
 *    refused (409 stale), so a replay on another instance can't roll names back past a newer save seen here; a
 *    draft must hash to the on-chain will_hash (409 will_hash).
 *    `basedOn` is the `updatedAt` the save was built on: stored names newer than that refuse it (409 stale).
 *  - save with `restoredFrom` (the owner's device putting back what the server lost, lib/estate-meta/keeper.ts): only
 *    fills what is missing, and never replaces a stored value, whatever either copy's age.
 *  - buyer-name: the wallet must hold an offer on one of this estate's assets (403 no_offer). Sets only that
 *    wallet's own name, and never replaces a name already given (the owner's names win).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { handler, HttpError, isChainMode, json, rateLimit } from "@/lib/api/http";
import { getEstateMeta, metaIsDurable, saveEstateMeta, saveWillDraft, type EstateMeta } from "@/lib/db";
import { willDraftSchema } from "@/lib/agent/schemas";
import { hashJson } from "@/lib/agent/hash";
import { verifyEd25519 } from "@/lib/legacy/server/auth";
import type { WillDraft } from "@/lib/types";
import { META_MAX_SKEW_MS, metaBody, metaMessage } from "./signed";
import { fillGaps, namesOf, OWNER_ROLE, verifierRole } from "./merge";
import { createNonces } from "@/lib/access/nonces";
import { memberReader, type MemberCheck } from "@/lib/access/server";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const signedFields = { estate: addr, wallet: addr, ts: z.number().int().positive(), sig: z.string().regex(/^[0-9a-f]{128}$/) };
const millis = z.number().int().nonnegative().max(Date.UTC(2100, 0));
const metaSchema = z.object({
  ownerName: z.string().min(1).max(80),
  verifierNames: z.tuple([z.string().max(64), z.string().max(64), z.string().max(64)]),
  assetTitles: z.record(z.string(), z.string().max(120)).default({}),
  buyerNames: z.record(z.string(), z.string().max(64)).default({}),
  draft: willDraftSchema.optional(),
  basedOn: millis.optional(),
  restoredFrom: millis.optional(),
});
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), ...signedFields, meta: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal("buyer-name"), ...signedFields, asset: addr, name: z.string().trim().min(1).max(64) }),
]);
const MAX_BODY = 200_000;

export interface EstateMetaRouteDeps {
  member?: MemberCheck;
  chain(): boolean;
  /** Milliseconds. */
  now(): number;
  /** The estate's on-chain owner and will hash (hex, or null before a will is set), or null when it doesn't exist. */
  estate(estate: string): Promise<{ owner: string; willHash: string | null } | null>;
  /** True when `buyer` holds an offer on `asset` and the asset belongs to `estate`. */
  hasOffer(estate: string, asset: string, buyer: string): Promise<boolean>;
  /** Throws when the store can't be read. */
  get(estate: string): Promise<EstateMeta | null>;
  /** Saves only if what is stored is still `prev`; false when it changed meanwhile. */
  save(meta: EstateMeta, prev: EstateMeta | null): Promise<boolean>;
  durable?(): boolean;
  saveDraft(ownerWallet: string, draft: WillDraft, willHash: string): Promise<void>;
}

async function chainEstate(estate: string) {
  const { fetchAccountRaw } = await import("@/lib/chain/reads");
  const { hex, key } = await import("@/lib/chain/decoders");
  const raw = await fetchAccountRaw("Estate", estate);
  if (!raw) return null;
  let willHash: string | null = null;
  try { willHash = hex(raw, "will_hash"); } catch { /* no will yet */ }
  return { owner: key(raw, "owner"), willHash };
}

async function chainHasOffer(estate: string, asset: string, buyer: string) {
  const { fetchAccountRaw } = await import("@/lib/chain/reads");
  const { key } = await import("@/lib/chain/decoders");
  const { offerPda } = await import("@/lib/chain/pda");
  const { chainConfig } = await import("@/lib/chain/config");
  const [a, o] = await Promise.all([
    fetchAccountRaw("Asset", asset),
    fetchAccountRaw("Offer", offerPda(new PublicKey(chainConfig.programId), asset, buyer).toBase58()),
  ]);
  return !!a && !!o && key(a, "estate") === estate && key(o, "buyer") === buyer;
}

const defaults: EstateMetaRouteDeps = {
  chain: isChainMode, now: () => Date.now(), estate: chainEstate, hasOffer: chainHasOffer,
  get: (estate) => getEstateMeta(estate, { strict: true }), save: saveEstateMeta, saveDraft: saveWillDraft, durable: metaIsDurable,
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * A buyer's own name stays marked as theirs through the owner's saves, which send the whole map back: only a name the
 * owner changed (or removed) loses the mark.
 */
function stillSelfNamed(held: EstateMeta | null, buyerNames: Record<string, string>): Pick<EstateMeta, "selfNamed"> {
  const kept = Object.entries(held?.selfNamed ?? {}).filter(([w, n]) => buyerNames[w] === n);
  return kept.length ? { selfNamed: Object.fromEntries(kept) } : {};
}

export function estateMetaRoutes(deps: EstateMetaRouteDeps = defaults) {
  const firstUse = createNonces("estate-meta", META_MAX_SKEW_MS * 2);
  /** The newest save this instance stored, by estate (ms). */
  const lastSave = new Map<string, number>();

  const GET = handler(async (req) => {
    rateLimit(req, "estate-meta", 60);
    const asked = new URL(req.url).searchParams.get("estate");
    if (asked === null) return json({ durable: deps.durable?.() ?? false });
    const estate = addr.parse(asked);
    const meta = await deps.get(estate);
    if (!meta) return json(null);
    if (await (deps.member ?? memberReader)(req, estate)) return json(meta);
    return json({
      estate: meta.estate, ownerWallet: meta.ownerWallet, assetTitles: meta.assetTitles,
      ownerName: OWNER_ROLE, verifierNames: [verifierRole(0), verifierRole(1), verifierRole(2)], buyerNames: {},
    } satisfies EstateMeta);
  });

  const POST = handler(async (req) => {
    rateLimit(req, "estate-meta-write", 10);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "Request too large", "too_large");
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, "Request too large", "too_large");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON.", "bad_input"); }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "That request is not in the expected shape.", "bad_input");
    const b = parsed.data;
    if (!deps.chain()) throw new HttpError(503, "The demo keeps names in the browser.", "unavailable");

    const now = deps.now();
    if (Math.abs(now - b.ts) > META_MAX_SKEW_MS) throw new HttpError(401, "This request is too old. Please try again.", "stale");
    // The signed text is the canonical JSON of what was sent (before defaults), so both sides hash the same thing.
    const payload = b.action === "save" ? b.meta : { asset: b.asset, name: (raw as { name: string }).name };
    if (!verifyEd25519(b.wallet, metaMessage(b.action, b.estate, b.wallet, b.ts, sha(metaBody(payload))), b.sig)) {
      throw new HttpError(401, "The signature does not match this wallet.", "unauthorized");
    }
    if (!(await firstUse(b.sig, now))) throw new HttpError(401, "This request was already used. Please try again.", "replay");

    const onChain = await deps.estate(b.estate);
    if (!onChain) throw new HttpError(404, "Estate not found on-chain.", "not_found");

    if (b.action === "buyer-name") {
      if (!(await deps.hasOffer(b.estate, b.asset, b.wallet))) throw new HttpError(403, "Only a buyer with an offer can give a name here.", "no_offer");
      const meta = await deps.get(b.estate);
      // No names saved for this estate (yet): nothing to add the buyer to; the family sees the short address.
      if (!meta) return json({ ok: true, saved: false });
      if (meta.buyerNames[b.wallet]) return json({ ok: true, saved: false });
      // Shown beside the offer, never trusted as who this wallet is (selfNamed).
      const next = {
        ...meta, buyerNames: { ...meta.buyerNames, [b.wallet]: b.name }, selfNamed: { ...meta.selfNamed, [b.wallet]: b.name },
        updatedAt: (meta.updatedAt ?? 0) + 1,
      };
      return json({ ok: true, saved: await deps.save(next, meta) });
    }

    if (onChain.owner !== b.wallet) throw new HttpError(403, "Only the estate owner can name it.", "forbidden");
    const m = metaSchema.safeParse(b.meta);
    if (!m.success) throw new HttpError(400, "That request is not in the expected shape.", "bad_input");
    const { draft, basedOn, restoredFrom, ...names } = m.data;
    if (restoredFrom !== undefined) {
      const held = await deps.get(b.estate);
      const filled = fillGaps(held ? namesOf(held) : null, names);
      if (!filled.changed) return json({ ok: true, saved: false });
      const updatedAt = held ? (held.updatedAt ?? 0) + 1 : Math.min(restoredFrom, b.ts);
      const saved = await deps.save({ estate: b.estate, ownerWallet: b.wallet, ...filled.names, ...stillSelfNamed(held, filled.names.buyerNames), updatedAt }, held);
      return json({ ok: true, saved, updatedAt });
    }
    if ((lastSave.get(b.estate) ?? 0) > b.ts) throw new HttpError(409, "Newer names were already saved. Reload and try again.", "stale");
    const willHash = draft ? await hashJson(draft) : null;
    if (willHash && onChain.willHash !== willHash) throw new HttpError(409, "Draft does not match the on-chain will hash.", "will_hash");
    const stored = await deps.get(b.estate);
    const newerThan = basedOn ?? b.ts;
    if (stored && (stored.updatedAt ?? 0) > newerThan) throw new HttpError(409, "Newer names were already saved. Reload and try again.", "stale");
    // The last line of defence against a save built from the redacted view (roles in place of names).
    if (names.ownerName === OWNER_ROLE && stored && stored.ownerName !== names.ownerName) {
      throw new HttpError(409, "Unlock your wallet and reload before changing names.", "redacted");
    }
    const updatedAt = Math.max(b.ts, (stored?.updatedAt ?? 0) + 1, (basedOn ?? 0) + 1);
    if (!(await deps.save({ estate: b.estate, ownerWallet: b.wallet, ...names, ...stillSelfNamed(stored, names.buyerNames), updatedAt }, stored))) {
      throw new HttpError(409, "Newer names were already saved. Reload and try again.", "stale");
    }
    lastSave.set(b.estate, b.ts);
    if (draft && willHash) await deps.saveDraft(b.wallet, draft, willHash);
    return json({ ok: true, saved: true, willHash, updatedAt });
  });

  return { GET, POST };
}
