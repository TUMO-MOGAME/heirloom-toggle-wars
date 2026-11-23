/** Who the screens offer "Dispute this" to (plan §18.4 R7, R9). */
import { describe, expect, it } from "vitest";
import type { EstateSnapshot } from "@/lib/service";
import type { Objection } from "@/lib/guardians/types";
import type { Dispute } from "@/lib/disputes/types";
import { canDispute } from "./disputes";

const snap = (over: { status?: string; objections?: Partial<Objection>[]; disputes?: Partial<Dispute>[]; kidActive?: boolean } = {}) => ({
  estate: {
    address: "E", status: over.status ?? "DeathPending", verifiers: ["A", "B", "C"], waitingPeriodSecs: 60,
    death: { submittedBy: "SIB", submittedAt: 800, pendingSince: 900 },
  },
  beneficiaries: [{ wallet: "KID", active: over.kidActive ?? true }, { wallet: "SIB", active: true }],
  claims: [{ address: "CL", beneficiary: "KID", status: "Open" }],
  hardships: [],
  disputes: over.disputes ?? [],
  guardians: { objections: over.objections ?? [] },
}) as unknown as EstateSnapshot;

describe("canDispute", () => {
  it("family still in the plan and trusted people may", () => {
    expect(canDispute(snap(), "KID", "Unlock", "E")).toBe(true);
    expect(canDispute(snap(), "A", "Claim", "CL")).toBe(true);
    expect(canDispute(snap({ kidActive: false }), "KID", "Unlock", "E")).toBe(false);
    expect(canDispute(snap(), "SOMEONE", "Unlock", "E")).toBe(false);
  });
  it("never whoever gains: the claimant, or who reported the death", () => {
    expect(canDispute(snap(), "KID", "Claim", "CL")).toBe(false);
    expect(canDispute(snap(), "SIB", "Unlock", "E")).toBe(false);
  });
  it("the unlock only while it waits", () => {
    expect(canDispute(snap({ status: "Active" }), "KID", "Unlock", "E")).toBe(false);
  });
  it("an objection in force takes the one challenge; a voided one from before this death doesn't", () => {
    const o = { target: "E", status: "Open" as const, raisedAt: 500 };
    expect(canDispute(snap({ objections: [{ ...o, lapsesAt: 9000 }] }), "KID", "Unlock", "E", 2000)).toBe(false);
    expect(canDispute(snap({ objections: [{ ...o, lapsesAt: 500 }] }), "KID", "Unlock", "E", 2000)).toBe(true);
  });
  it("a dispute settled for this death stands; one from an earlier death doesn't", () => {
    const d = { target: "E", status: "Dismissed" as const };
    expect(canDispute(snap({ disputes: [{ ...d, raisedAt: 950 }] }), "KID", "Unlock", "E")).toBe(false);
    expect(canDispute(snap({ disputes: [{ ...d, raisedAt: 500 }] }), "KID", "Unlock", "E")).toBe(true);
  });
});
