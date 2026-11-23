/**
 * The CarBroker's rank_offers tool ranks as accept_offer will check (lib/chain/sale-timing.ts): on chain an offer still
 * in its objection window is not called the best one, and the tool says from when it can be accepted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EstateFacts } from "./facts";

vi.mock("server-only", () => ({}));
const calls: unknown[][] = [];
vi.mock("./gemini", async (orig) => ({
  ...(await orig<typeof import("./gemini")>()),
  hasGemini: () => true,
  generate: vi.fn(async (opts: { contents: unknown[] }) => {
    calls.push([...opts.contents]);
    return calls.length === 1
      ? { functionCalls: [{ id: "1", name: "rank_offers", args: {} }], candidates: [{ content: { role: "model", parts: [] } }] }
      : { functionCalls: [], text: "ok" };
  }),
}));
const NOW = 1_000_000;
vi.mock("../server/estate", () => ({
  loadPublicSnapshot: async () => ({
    estate: { agent: "AGENT", verifiers: ["V1", "V2", "11111111111111111111111111111111"] },
    assets: [{ address: "CAR", floorPrice: 100_000_000n, hardshipFloor: 50_000_000n, hardshipBeneficiary: null, status: "Listed" }],
    offers: [
      { address: "OLD", asset: "CAR", buyer: "B1", amount: 120_000_000n, createdAt: NOW - 100 },
      { address: "NEW", asset: "CAR", buyer: "B2", amount: 150_000_000n, createdAt: NOW - 10 },
    ],
  }),
}));
vi.mock("../chain/sale-timing", () => ({
  loadSaleTiming: async () => ({ now: NOW, objectionWindowSecs: 60, saleObjectionUpheldAt: null, hardshipQuorumAt: null }),
}));
const { runSpecialist } = await import("./specialists");

afterEach(() => { vi.unstubAllEnvs(); calls.length = 0; });

const facts = {
  estate: { address: "EST", status: "Unlocked", ownerName: "O", vaultUsdt: 0, waitingPeriodSecs: 60, deathThreshold: 1, claimThreshold: 1, hardshipThreshold: 1, death: { verdict: "Approved", attestations: 1, pendingSince: 1 } },
  beneficiaries: [], payees: [], rules: [], claims: [], hardships: [], recentActivity: [],
  asset: { address: "CAR", title: "Car", status: "Listed", floorUsdt: 100, hardshipFloorUsdt: 50, askingUsdt: 160, hardshipApproved: false, listingEnds: null },
  // What the browser sent: names for buyers and no timing. On chain the tool reads the chain instead.
  offers: [{ address: "OLD", buyer: "Pieter", amountUsdt: 120, createdAt: NOW - 100 }, { address: "NEW", buyer: "Sipho", amountUsdt: 150, createdAt: NOW - 10 }],
} satisfies EstateFacts;

const toolResult = () => {
  const last = calls[1]?.at(-1) as { parts: { functionResponse: { response: { result: Record<string, unknown> } } }[] };
  return last.parts[0].functionResponse.response.result as { bestOffer: string | null; ineligible: { offer: string; acceptableFrom?: string }[]; note?: string };
};

describe("rank_offers matches what can be signed", () => {
  it("on chain an offer in its objection window isn't the best yet, and says from when", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "chain");
    await runSpecialist("CarBroker", { history: [{ role: "user", text: "Which offer wins?" }], facts, context: {} });
    const r = toolResult();
    expect(r.bestOffer).toBe("OLD");
    expect(r.ineligible).toEqual([expect.objectContaining({ offer: "NEW", acceptableFrom: new Date((NOW + 50) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" })]);
    expect(r.note).toBeUndefined();
  });

  it("in the demo it ranks the facts it was given", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock");
    await runSpecialist("CarBroker", { history: [{ role: "user", text: "Which offer wins?" }], facts, context: {} });
    expect(toolResult().bestOffer).toBe("NEW");
  });
});
