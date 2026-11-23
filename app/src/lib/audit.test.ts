/** The public record (/audit/<estate>): what it keeps, what it drops, and how it splits payments from decisions. */
import { describe, expect, it } from "vitest";
import { auditDecisions, auditPayments, isMissingEstate, looksLikeAddress, PAYMENT_KINDS, publicSnapshot } from "./audit";
import { createMockService, DEMO_PERSONAS } from "./service/mock";
import { ProgramError } from "./service/mock-errors";

async function unlocked() {
  const svc = createMockService({ instant: true });
  svc.resetDemo("guardians");
  const thabo = DEMO_PERSONAS.find((p) => p.key === "thabo")!;
  const [{ estate }] = await svc.listEstatesFor(thabo.address);
  return svc.getEstate(estate);
}

describe("publicSnapshot", () => {
  it("drops the agent's document reports and the guardian details, keeps every document hash", async () => {
    const snap = await unlocked();
    expect(snap.estate.death.agentReport).toBeTruthy();
    expect(snap.guardians?.enabled).toBe(true);
    const pub = publicSnapshot(snap);
    expect(pub.estate.death.agentReport).toBeUndefined();
    expect(pub.estate.death.certHash).toBe(snap.estate.death.certHash);
    expect(pub.guardians).toBeUndefined();
    expect(pub.claims.every((c) => c.agentReport === undefined)).toBe(true);
    expect(pub.hardships.every((h) => h.agentReport === undefined)).toBe(true);
    expect(pub.assets.map((a) => a.docHash)).toEqual(snap.assets.map((a) => a.docHash));
    expect(pub.estate.willHash).toBe(snap.estate.willHash);
    // Nothing in the record quotes the documents.
    expect(JSON.stringify(pub, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/"extracted"|"redFlags"/);
  });

  it("does not change the snapshot it was given", async () => {
    const snap = await unlocked();
    publicSnapshot(snap);
    expect(snap.estate.death.agentReport).toBeTruthy();
  });
});

describe("payments and decisions", () => {
  it("split the timeline with nothing lost, each with its receipt", async () => {
    const snap = await unlocked();
    const pay = auditPayments(snap), dec = auditDecisions(snap);
    expect(pay.length + dec.length).toBe(snap.activity.length);
    expect(pay.every((a) => PAYMENT_KINDS.has(a.kind))).toBe(true);
    expect(pay.map((a) => a.kind)).toContain("Deposit");
    expect(dec.map((a) => a.kind)).toEqual(expect.arrayContaining(["DeathAttested", "EstateUnlocked"]));
    expect([...pay, ...dec].every((a) => !!a.txSignature)).toBe(true);
  });
});

describe("isMissingEstate / looksLikeAddress", () => {
  it("tells 'no estate here' apart from a network problem", () => {
    expect(isMissingEstate(new ProgramError("NoEstate", "There is no estate yet."))).toBe(true);
    expect(isMissingEstate(new Error("No Heirloom estate at abc on this cluster."))).toBe(true);
    expect(isMissingEstate(new Error("Invalid public key input"))).toBe(true);
    expect(isMissingEstate(new Error("429 Too Many Requests"))).toBe(false);
    expect(isMissingEstate(null)).toBe(false);
  });

  it("accepts base58 addresses only", () => {
    expect(looksLikeAddress("JBdsDy67YBfpV8YAc2H1h7w95h8uJ2XUzTDh9vt34G9E")).toBe(true);
    expect(looksLikeAddress("EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo")).toBe(true); // the demo estate
    expect(looksLikeAddress("not-an-address")).toBe(false);
    expect(looksLikeAddress("0OIl".repeat(10))).toBe(false);
  });
});
