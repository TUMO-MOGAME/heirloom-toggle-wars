/**
 * acceptBestOffer on Solana (U4): this trusted person's wallet signs the sale of the highest eligible offer, for that
 * amount, and /api/accept-offer adds the agent's signature after checking the same bytes (lib/agent/sale.ts).
 */
import type { Base58, OfferRanking } from "../types";
import type { SeenOffer, TxResult } from "./types";
import { rankOffers, type SaleTiming } from "../agent/offers";
import { saleTransaction } from "../agent/sale";
import { eligibleSeats } from "../death-rules";
import { actionBody } from "../access/messages";
import { chainCtx } from "../chain/client";
import type { RawSnapshot } from "../chain/reads";
import { bytesToBase64 } from "../chain/tx";
import { getActiveSigner } from "../wallet/signer";
import { ChainServiceError, must } from "./chain-errors";

export interface ChainSaleDeps {
  /** The estate read afresh. */
  fetchEstate(estate: Base58): Promise<RawSnapshot>;
  latestBlockhash(): Promise<string>;
  /** What the program checks against the clock (lib/chain/sale-timing.ts), read as the agent's server reads it. */
  saleTiming(estate: Base58, asset: { address: Base58; hardshipBeneficiary: Base58 | null }): Promise<SaleTiming>;
  /** The signed request headers for this action and body. */
  headers(estate: Base58, body: string): Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

export interface WireRanking {
  bestOffer: Base58 | null;
  eligible: { offer: Base58; amount: string; reason: string }[];
  ineligible: { offer: Base58; amount: string; reason: string }[];
}

/** OfferRanking amounts come back from JSON as strings. */
export function reviveRanking(r: WireRanking): OfferRanking {
  const f = (x: WireRanking["eligible"][number]) => ({ ...x, amount: BigInt(x.amount) });
  return { bestOffer: r.bestOffer, eligible: r.eligible.map(f), ineligible: r.ineligible.map(f) };
}

export async function acceptBestOffer(d: ChainSaleDeps, estate: Base58, assetAddress: Base58, seen?: SeenOffer | null): Promise<{ tx: TxResult; ranking: OfferRanking }> {
  const f = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const snap = await d.fetchEstate(estate);
  const { agent, verifiers } = snap.estate;
  const asset = snap.assets.find((a) => a.address === assetAddress);
  must(asset, "BadStatus", "That asset is not in this plan.");
  const offers = snap.offers.filter((o) => o.asset === asset.address);
  // Offers the program would refuse now (too old, still in their objection window) are never the one signed.
  const timing = await d.saleTiming(estate, asset);
  const ranked = rankOffers(asset, offers, { agent, verifiers }, timing);
  const best = offers.find((o) => o.address === ranked.bestOffer);
  // Seen as "no acceptable offer": one that arrived since is shown first, never signed unread.
  must(seen !== null || !best, "OfferChanged", "An offer arrived after you looked. Check it before you sign.");
  const ready = ranked.ineligible.flatMap((r) => (r.readyAt ? [r.readyAt] : []));
  if (!best && ready.length) {
    throw new ChainServiceError("ObjectionWindowOpen", "Monitors can still object, so no offer can be accepted yet. Try again once the window closes.", Math.min(...ready));
  }
  must(best, asset.hardshipBeneficiary ? "BelowHardshipFloor" : "BelowFloor", "No offer can be accepted yet.");

  // Nobody signs for an offer, amount or recipient other than the one they read.
  const recipient = asset.hardshipBeneficiary ?? asset.proceedsTo;
  must(!seen || (seen.offer === best.address && seen.amount === best.amount && seen.recipient === recipient), "OfferChanged",
    "The offer or who gets the money changed after you read it. Check the new one before you sign.");
  const signer = getActiveSigner();
  const me = signer.address;
  const seats = eligibleSeats(verifiers);
  let tx: string | undefined; // none only when no seat has a holder: the agent then signs alone, after the listing
  if (seats.length) {
    must(seats.some((i) => verifiers[i] === me), "NotVerifier", "Only a trusted person can co-sign the sale.");
    must(best.buyer !== me, "CoSignerRequired", "You can't co-sign a sale to yourself. Ask another trusted person.");
    must(signer.signPartial, "CoSignerRequired", "This wallet can't co-sign. Use your Heirloom wallet for this.");
    const sale = saleTransaction(chainCtx(), { estate, agent, asset, offer: best, coSigner: me }, await d.latestBlockhash());
    tx = (await signer.signPartial(bytesToBase64(sale.serialize({ requireAllSignatures: false, verifySignatures: false })))).wireBase64;
  }

  const res = await f("/api/accept-offer", {
    method: "POST", body: JSON.stringify({ estate, asset: asset.address, tx }),
    headers: { "content-type": "application/json", ...(await d.headers(estate, actionBody.acceptOffer({ asset: asset.address, tx }))) },
  });
  const data = (await res.json().catch(() => ({}))) as { tx?: TxResult | null; ranking?: WireRanking; error?: string; code?: string };
  if (!res.ok || !data.tx || !data.ranking) {
    throw new ChainServiceError(data.code ?? `http_${res.status}`, data.error ?? `The sale could not be accepted (${res.status}).`);
  }
  return { tx: data.tx, ranking: reviveRanking(data.ranking) };
}
