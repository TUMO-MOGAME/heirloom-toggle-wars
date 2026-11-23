/** What the agent is told after the second review: removed people, replaced rules, votes that don't count. */
import { describe, expect, it } from "vitest";
import { toEstateFacts } from "./facts";
import { estateFactsSchema } from "./facts-schema";
import type { EstateSnapshot } from "../service/types";

const EMPTY = "11111111111111111111111111111111";
const rule = (id: number, beneficiary: string) => ({
  address: `R${id}`, id, beneficiary, category: "Books", allowedPayeeKind: "School", maxPerClaim: 5n, lifetimeCap: 50n, spentTotal: 0n, validUntil: 9_999, startsNow: true,
});
const claim = (id: string, over: Record<string, unknown> = {}) => ({
  address: id, rule: "R0", beneficiary: "IN", amount: 5n, status: "Open", agentVerdict: "Approved", approvals: [true, true, true], ...over,
});
const snap = {
  estate: {
    address: "E", status: "Active", ownerName: "Owner", vaultBalance: 0n, verifiers: ["V", EMPTY, "IN"], verifierNames: ["v", "", "w"],
    waitingPeriodSecs: 60, deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2,
    death: { verdict: "Approved", attestations: [true, true, true], pendingSince: null, submittedBy: "IN" },
  },
  beneficiaries: [{ wallet: "IN", label: "Family member 1", active: true }, { wallet: "OUT", label: "Family member 2", active: false }],
  payees: [], rules: [rule(0, "IN"), rule(1, "OUT")],
  claims: [
    claim("now"), claim("early", { approvalsCount: false }), claim("old", { fromEndedRule: true }),
    claim("gone", { beneficiary: "OUT" }), claim("paid", { beneficiary: "OUT", status: "Paid" }),
  ],
  assets: [], offers: [], hardships: [{ address: "H", beneficiary: "IN", status: "Open", agentVerdict: "Approved", approvals: [true, true, true] }],
  activity: [],
} as unknown as EstateSnapshot;

describe("agent facts", () => {
  const f = toEstateFacts(snap);
  const claimOf = (id: string) => f.claims.find((c) => c.address === id)!;

  it("leave out removed family members and their rules", () => {
    expect(f.beneficiaries.map((b) => b.wallet)).toEqual(["IN"]);
    expect(f.rules.map((r) => r.id)).toEqual([0]);
  });

  it("count only held seats, never a vote in one's own favour", () => {
    expect(f.estate.death.attestations).toBe(1);
    expect(claimOf("now").approvals).toBe(1);
    expect(f.hardships[0].approvals).toBe(1);
  });

  it("say when a claim can't be paid, and don't count approvals from before the death", () => {
    expect(claimOf("early").approvals).toBe(0);
    expect(claimOf("old").status).toMatch(/Cannot be paid/);
    expect(claimOf("gone").status).toMatch(/Cannot be paid/);
    expect(claimOf("paid").status).toBe("Paid");
    expect(() => estateFactsSchema.parse(f)).not.toThrow();
  });
});
