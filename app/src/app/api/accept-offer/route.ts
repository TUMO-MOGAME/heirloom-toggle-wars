import type { Transaction } from "@solana/web3.js";
import { handler, HttpError, isChainMode, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { acceptOfferBody } from "@/lib/agent/schemas";
import { rankOffers } from "@/lib/agent/offers";
import { checkSaleTx, mayAskForSale, saleInstruction, SaleRefused } from "@/lib/agent/sale";
import { refusedByProgram } from "@/lib/agent/refusal";
import { eligibleSeats } from "@/lib/death-rules";
import { chainCtx } from "@/lib/chain/client";
import { invalidateProgramAccounts } from "@/lib/chain/reads";
import { loadSaleTiming } from "@/lib/chain/sale-timing";
import { base64ToBytes, getConnection } from "@/lib/chain/tx";
import { agentAddress, agentCoSignSale, agentSignAndSend, hasAgentWallet } from "@/lib/agent/agent-wallet";
import { loadPublicSnapshot } from "@/lib/server/estate";
import { spendAgentAllowance, spendAgentRent } from "@/lib/agent/budget";
import { assertServedEstate, verifyAction } from "@/lib/access/server";
import { actionBody } from "@/lib/access/messages";
import { assertProgram } from "@/lib/server/program";

export const maxDuration = 60;

/**
 * POST /api/accept-offer { estate, asset, tx }, the request signed by a living trusted person who is not the buyer.
 * `tx` is the sale they signed for one offer and amount (lib/agent/sale.ts). The agent reads the chain afresh, ranks
 * the offers (floor / hardship floor) and adds its signature only when `tx` is byte for byte the sale of the highest
 * eligible offer, co-signed by this caller, on a blockhash that still holds: USD₮ and the title swap in one
 * transaction. Anything else is refused and nothing is signed.
 *
 * With no trusted person left there is nobody to co-sign: once the listing has ended an active family member who is
 * not the buyer may ask, and the agent signs alone (the program allows only then).
 *
 * Returns { tx, ranking }. 409 if no offer is eligible, or the sale changed or went stale.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "accept-offer", 20);
  const b = await parseJson(req, acceptOfferBody);
  if (!isChainMode()) throw new HttpError(409, "On-chain sale runs in chain mode only.");
  const wallet = await verifyAction(req, "accept-offer", b.estate, actionBody.acceptOffer(b));
  if (!hasAgentWallet()) throw new HttpError(503, "The agent wallet is not configured (AGENT_SEED_PHRASE).");
  await assertProgram();
  invalidateProgramAccounts(); // a higher or withdrawn offer of a second ago must count
  const snap = await loadPublicSnapshot(b.estate);
  const { verifiers } = snap.estate;
  const seats = eligibleSeats(verifiers);
  if (!mayAskForSale(verifiers, snap.beneficiaries, wallet)) {
    throw new HttpError(403, "Only the estate's trusted people can settle a sale.", "forbidden");
  }
  const asset = snap.assets.find((a) => a.address === b.asset);
  if (!asset) throw new HttpError(404, "Asset not found in this estate.");
  const offers = snap.offers.filter((o) => o.asset === asset.address);
  // Never an offer the program would refuse now: made before an upheld sale objection, or still in an objection window.
  const ranking = rankOffers(asset, offers, { agent: snap.estate.agent, verifiers }, await loadSaleTiming(b.estate, asset));
  const best = offers.find((o) => o.address === ranking.bestOffer);
  if (!best) {
    const waiting = ranking.ineligible.some((r) => r.readyAt);
    return json({
      tx: null, ranking,
      ...(waiting
        ? { error: "ObjectionWindowOpen: monitors can still object, so no offer can be accepted yet.", code: "ObjectionWindowOpen" }
        : { error: "No offer meets the floor price (or the hardship floor)." }),
    }, { status: 409 });
  }

  if (best.buyer === wallet) throw new HttpError(403, "You cannot settle a sale to yourself. Ask another trusted person.", "own_offer");
  const agentKey = await agentAddress();
  assertServedEstate(snap.estate, agentKey);
  const ctx = chainCtx();
  const sale = { estate: b.estate, agent: agentKey!, asset, offer: best };

  if (!seats.length) {
    if (asset.listingEnds === null || Date.now() / 1000 < asset.listingEnds) {
      throw new HttpError(409, "ListingStillOpen: with no trusted people left, the sale waits until the listing ends.", "ListingStillOpen");
    }
    const alone = saleInstruction(ctx, { ...sale, coSigner: null });
    if (alone.keys.filter((k) => k.pubkey.toBase58() === agentKey).length !== 1) {
      throw new HttpError(409, "The agent's wallet can't be an account of a sale.", "agent_account");
    }
    await spendAgentAllowance("accept-offer", wallet, b.estate);
    await spendAgentRent("settle", b.estate);
    const tx = await agentSignAndSend([alone]).catch(refusedByProgram);
    return json({ tx, ranking });
  }

  if (!b.tx) throw new HttpError(400, "Sign the sale in your wallet: the agent can't sell by itself.", "co_sign_required");
  let signed: Transaction;
  try {
    signed = checkSaleTx(base64ToBytes(b.tx), ctx, { ...sale, coSigner: wallet });
  } catch (e) {
    if (e instanceof SaleRefused) throw new HttpError(e.code === "sale_changed" ? 409 : 422, e.message, e.code);
    if (e instanceof Error && e.name === "InvalidCharacterError") throw new HttpError(422, "The signed sale is not base64.", "bad_sale_tx");
    throw e;
  }
  if (!(await getConnection().isBlockhashValid(signed.recentBlockhash!, { commitment: "confirmed" })).value) {
    throw new HttpError(409, "The signed sale is too old to send. Look at the offers and sign again.", "stale_sale");
  }
  await spendAgentAllowance("accept-offer", wallet, b.estate);
  await spendAgentRent("settle", b.estate);
  const tx = await agentCoSignSale(signed).catch(refusedByProgram);
  return json({ tx, ranking });
});
