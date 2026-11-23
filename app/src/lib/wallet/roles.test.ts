import { describe, expect, it } from "vitest";
import { canStartOwnPlan } from "./roles";
import { withRole, type StoredWallet } from "./store";

describe("starting your own plan from another role", () => {
  it("offers it on an owner page to a non-owner on chain", () => {
    expect(canStartOwnPlan(["owner"], "beneficiary", false)).toBe(true);
    expect(canStartOwnPlan(["owner"], "verifier", false)).toBe(true);
  });
  it("not to the owner, not on pages for other roles, not in the demo", () => {
    expect(canStartOwnPlan(["owner"], "owner", false)).toBe(false);
    expect(canStartOwnPlan(["verifier"], "beneficiary", false)).toBe(false);
    expect(canStartOwnPlan(undefined, "beneficiary", false)).toBe(false);
    expect(canStartOwnPlan(["owner"], "beneficiary", true)).toBe(false);
  });
  it("changes only that wallet's role in the stored list", () => {
    const list = [
      { kind: "phone", address: "A", label: "Lerato", role: "beneficiary", wallet: "x", createdAt: 1 },
      { kind: "phone", address: "B", label: "Pieter", role: "buyer", wallet: "x", createdAt: 2 },
    ] as StoredWallet[];
    const out = withRole(list, "A", "owner");
    expect(out.map((w) => w.role)).toEqual(["owner", "buyer"]);
    expect(out[0]).toEqual({ ...list[0], role: "owner" });
    expect(list[0].role).toBe("beneficiary");
  });
});
