/** The shape of EstateFacts (lib/agent/facts.ts), checked by the orchestrate route. Server and tests only, so the browser never needs zod for it. */
import { z } from "zod";

export const estateFactsSchema = z.object({
  estate: z.object({
    address: z.string(), status: z.string(), ownerName: z.string(), vaultUsdt: z.number(),
    /** The owner's "trusted people" (verifiers): they confirm a passing and approve claims after unlock. */
    verifierNames: z.array(z.string()).max(3).optional(),
    waitingPeriodSecs: z.number(), deathThreshold: z.number(), claimThreshold: z.number(), hardshipThreshold: z.number(),
    death: z.object({ verdict: z.string(), attestations: z.number(), pendingSince: z.number().nullable() }),
  }),
  beneficiaries: z.array(z.object({ wallet: z.string(), label: z.string() })).max(20),
  payees: z.array(z.object({ wallet: z.string(), name: z.string(), kind: z.string() })).max(30),
  rules: z.array(z.object({
    address: z.string(), id: z.number(), beneficiary: z.string(), beneficiaryLabel: z.string(), category: z.string(),
    allowedPayeeKind: z.string(), maxPerClaimUsdt: z.number(), lifetimeCapUsdt: z.number(), spentUsdt: z.number(),
    remainingUsdt: z.number(), validUntil: z.number(),
    /** Living plan: claimable while the owner is alive. False/absent = only after the passing (estate Unlocked). */
    startsNow: z.boolean().optional(),
  })).max(30),
  claims: z.array(z.object({
    address: z.string(), rule: z.string(), amountUsdt: z.number(), status: z.string(), agentVerdict: z.string(),
    approvals: z.number(), redFlags: z.array(z.string()).optional(),
  })).max(20),
  asset: z.object({
    address: z.string(), title: z.string(), status: z.string(), floorUsdt: z.number(), hardshipFloorUsdt: z.number(),
    askingUsdt: z.number(), hardshipApproved: z.boolean(), listingEnds: z.number().nullable(),
  }).nullable(),
  offers: z.array(z.object({ address: z.string(), buyer: z.string(), amountUsdt: z.number(), createdAt: z.number() })).max(30),
  hardships: z.array(z.object({ address: z.string(), status: z.string(), agentVerdict: z.string(), approvals: z.number() })).max(10),
  recentActivity: z.array(z.string()).max(10),
});
