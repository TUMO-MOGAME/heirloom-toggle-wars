/** The guided demo walk doesn't skip "claim" and "approve" after an everyday request (steps 10-11). */
import { describe, expect, it } from "vitest";
import { createMockService, DEMO_PERSONAS } from "./service/mock";
import { claimedAfterDeath } from "./schedule-step";

describe("claimedAfterDeath", () => {
  it("an ask from before the passing is not the story's claim; a claim after it is", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const thabo = DEMO_PERSONAS.find((p) => p.key === "thabo")!;
    svc.setActor({ address: thabo.address, role: thabo.role, label: thabo.label });
    const [{ estate }] = await svc.listEstatesFor(thabo.address);
    svc.simulatePassing(); svc.skipWait();
    const s = await svc.getEstate(estate);
    expect(s.claims.length).toBeGreaterThan(0);
    expect(claimedAfterDeath(s)).toBe(false);
    svc.simulateSeatApproval(2);
    expect(claimedAfterDeath(await svc.getEstate(estate))).toBe(true);
  });
});
