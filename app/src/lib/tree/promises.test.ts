/**
 * Promise rules (plan.md §15.4), one test per rule, plus what is never shown: a vetoed passing, a dismissed or
 * lapsed challenge, approvals of a claim a challenge cancelled.
 */
import { describe, expect, it } from "vitest";
import type { TreeEvent } from "./events";
import {
  answeredRequests, approvedPayments, assetPaths, carriedOutFallback, challenges, confirmedPassing, guardianTerms, helpedHardship, keptPromises, planPaid,
} from "./promises";

const E = "Estate1111111111111111111111111111111111111";
const OWNER = "Owner11111111111111111111111111111111111111";
const V1 = "Verifier1111111111111111111111111111111111a";
const V2 = "Verifier2222222222222222222222222222222222b";
const V3 = "Verifier3333333333333333333333333333333333c";
const KID = "Kid1111111111111111111111111111111111111111";
const KID2 = "Kid2222222222222222222222222222222222222222";
const BACKUP = "Backup11111111111111111111111111111111111111";
const MON = "Monitor1111111111111111111111111111111111111";
const ctx = { owners: { [E]: OWNER } };

let n = 0;
const ev = (e: Record<string, unknown> & { kind: TreeEvent["kind"]; ts: number }): TreeEvent => ({ estate: E, sig: `sig${n++}`, ...e }) as TreeEvent;
const Y = (y: number, m = 1) => Date.UTC(y, m - 1, 10) / 1000;

const base = (): TreeEvent[] => [
  ev({ kind: "EstateCreated", owner: OWNER, ts: Y(2026) }),
  ev({ kind: "VerifiersSet", verifiers: [V1, V2, V3], ts: Y(2026) }),
  ev({ kind: "BeneficiaryAdded", wallet: KID, ts: Y(2026) }),
  ev({ kind: "BeneficiaryAdded", wallet: KID2, ts: Y(2026) }),
  ev({ kind: "RuleSet", rule: "ruleSchool", category: "Tuition", beneficiary: KID, ts: Y(2026) }),
  ev({ kind: "RuleSet", rule: "ruleBooks", category: "Books", beneficiary: KID2, ts: Y(2026) }),
];
const claim = (id: string, ts: number, beneficiary = KID, rule = "ruleSchool") => ev({ kind: "ClaimSubmitted", claim: id, rule, beneficiary, ts });

describe("rule 1: confirmed passing", () => {
  it("credits each trusted person who confirmed, with the others, once the unlock went through", () => {
    const k = confirmedPassing([...base(),
      ev({ kind: "DeathAttested", verifier: V1, ts: Y(2041, 3) }), ev({ kind: "DeathAttested", verifier: V2, ts: Y(2041, 3) }),
      ev({ kind: "EstateUnlocked", ts: Y(2041, 4) })], ctx);
    expect(k.map((x) => [x.kind, x.by, x.about, x.withOthers, x.count])).toEqual([
      ["confirmedPassing", V1, OWNER, 1, 1], ["confirmedPassing", V2, OWNER, 1, 1],
    ]);
  });
  it("gives nothing before the unlock, and nothing for confirmations a veto cancelled", () => {
    expect(confirmedPassing([...base(), ev({ kind: "DeathAttested", verifier: V1, ts: Y(2041) })], ctx)).toEqual([]);
    const k = confirmedPassing([...base(),
      ev({ kind: "DeathAttested", verifier: V3, ts: Y(2033) }), ev({ kind: "DeathVetoed", ts: Y(2033, 2) }),
      ev({ kind: "DeathAttested", verifier: V1, ts: Y(2041) }), ev({ kind: "DeathAttested", verifier: V2, ts: Y(2041) }), ev({ kind: "EstateUnlocked", ts: Y(2041, 2) })], ctx);
    expect(k.map((x) => x.by)).toEqual([V1, V2]);
  });
  it("credits whoever confirmed a seat holder's passing once the succession went through", () => {
    const k = confirmedPassing([...base(),
      ev({ kind: "SeatDeathReported", seat: 2, holder: V3, ts: Y(2044) }), ev({ kind: "SeatDeathConfirmed", seat: 2, by: V2, ts: Y(2044, 2) }),
      ev({ kind: "SuccessionFinalized", seat: 2, previous: V3, next: BACKUP, ts: Y(2044, 3) })], ctx);
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ by: V2, about: V3, withOthers: 0 });
    // A vetoed seat passing gives nothing.
    expect(confirmedPassing([...base(), ev({ kind: "SeatDeathConfirmed", seat: 2, by: V2, ts: Y(2044) }), ev({ kind: "SeatDeathVetoed", seat: 2, ts: Y(2044, 2) })], ctx)).toEqual([]);
  });
});

describe("rule 2: approved payments", () => {
  it("groups a trusted person's approvals per person and purpose, counting each claim once (ClaimApproved + SeatApproval)", () => {
    const k = approvedPayments([...base(),
      claim("c1", Y(2041)), ev({ kind: "ClaimApproved", claim: "c1", verifier: V1, ts: Y(2041, 2) }), ev({ kind: "SeatApproval", seat: 0, approver: V1, target: "c1", targetKind: "Claim", ts: Y(2041, 2) }),
      claim("c2", Y(2049)), ev({ kind: "ClaimApproved", claim: "c2", verifier: V1, ts: Y(2049, 2) }),
      claim("c3", Y(2045), KID2, "ruleBooks"), ev({ kind: "ClaimApproved", claim: "c3", verifier: V1, ts: Y(2045, 2) })]);
    expect(k).toHaveLength(2);
    const school = k.find((x) => x.purpose === "Tuition")!;
    expect(school).toMatchObject({ kind: "approvedPayments", by: V1, for: [KID], count: 2 });
    expect(new Date(school.firstTs * 1000).getUTCFullYear()).toBe(2041);
    expect(new Date(school.lastTs * 1000).getUTCFullYear()).toBe(2049);
    expect(school.tss).toHaveLength(2);
    expect(school.proofs.length).toBeLessThanOrEqual(5);
  });
  it("does not count approvals of a claim that an upheld challenge or objection cancelled", () => {
    const k = approvedPayments([...base(),
      claim("c1", Y(2046)), ev({ kind: "ClaimApproved", claim: "c1", verifier: V1, ts: Y(2046) }),
      ev({ kind: "ObjectionResolved", objection: "o1", target: "c1", targetKind: "Claim", upheld: true, ts: Y(2046, 2) })]);
    expect(k).toEqual([]);
  });
});

describe("rule 3: answered requests", () => {
  it("credits the owner for each living-plan request approved, per person", () => {
    const k = answeredRequests([...base(),
      claim("c1", Y(2027)), ev({ kind: "ClaimOwnerApproved", claim: "c1", owner: OWNER, ts: Y(2027) }),
      claim("c2", Y(2028)), ev({ kind: "ClaimOwnerApproved", claim: "c2", owner: OWNER, ts: Y(2028) })]);
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ kind: "answeredRequests", by: OWNER, for: [KID], count: 2 });
  });
});

describe("rule 4: the plan paid", () => {
  it("credits the owner per person and purpose, for claims and schedules alike, with no amount", () => {
    const k = planPaid([...base(),
      claim("c1", Y(2041)), ev({ kind: "ClaimPaid", claim: "c1", rule: "ruleSchool", ts: Y(2041, 2) }),
      ev({ kind: "ScheduledPaid", rule: "ruleBooks", ts: Y(2027) }), ev({ kind: "ScheduledPaid", rule: "ruleBooks", ts: Y(2028) })], ctx);
    expect(k.map((x) => [x.by, x.for[0], x.purpose, x.count])).toEqual(expect.arrayContaining([[OWNER, KID, "Tuition", 1], [OWNER, KID2, "Books", 2]]));
    expect(JSON.stringify(k)).not.toMatch(/amount/i);
  });
});

describe("rule 5: helped through a hard time", () => {
  it("credits the approvers of a hardship request that reached its quorum, not of one that did not", () => {
    const k = helpedHardship([...base(),
      ev({ kind: "HardshipSubmitted", hardship: "h1", asset: "a1", beneficiary: KID2, ts: Y(2042) }),
      ev({ kind: "HardshipApproved", hardship: "h1", verifier: V1, quorum: false, ts: Y(2042) }),
      ev({ kind: "HardshipApproved", hardship: "h1", verifier: V3, quorum: true, ts: Y(2042) }),
      ev({ kind: "HardshipSubmitted", hardship: "h2", asset: "a1", beneficiary: KID, ts: Y(2043) }),
      ev({ kind: "HardshipApproved", hardship: "h2", verifier: V2, quorum: false, ts: Y(2043) })]);
    expect(k.map((x) => [x.by, x.for[0]])).toEqual([[V1, KID2], [V3, KID2]]);
  });
});

describe("rule 6: guardian terms", () => {
  it("runs a seat holder's term from setup to succession, then the successor's to the end of the record", () => {
    const k = guardianTerms([...base(),
      ev({ kind: "SeatConfigured", seat: 2, holder: V3, backups: [BACKUP], monitors: [MON], ts: Y(2027) }),
      ev({ kind: "SeatConfigured", seat: 2, holder: V3, backups: [BACKUP], monitors: [], ts: Y(2030) }), // same holder: same term
      ev({ kind: "SuccessionFinalized", seat: 2, previous: V3, next: BACKUP, ts: Y(2044) }),
      ev({ kind: "ScheduledPaid", rule: "ruleBooks", ts: Y(2049) })], ctx);
    expect(k.map((x) => [x.by, new Date(x.firstTs * 1000).getUTCFullYear(), new Date(x.lastTs * 1000).getUTCFullYear()])).toEqual([[V3, 2027, 2044], [BACKUP, 2044, 2049]]);
    expect(k[0].for).toEqual([KID, KID2]);
  });
  it("ends a term when the seat is vacated", () => {
    const k = guardianTerms([...base(), ev({ kind: "SeatConfigured", seat: 1, holder: V2, backups: [], monitors: [], ts: Y(2027) }), ev({ kind: "SeatVacated", seat: 1, previous: V2, ts: Y(2030) })], ctx);
    expect(new Date(k[0].lastTs * 1000).getUTCFullYear()).toBe(2030);
  });
});

describe("rule 7: carried out the fallback plan", () => {
  it("credits the owner's plan, for the recipient", () => {
    const k = carriedOutFallback([...base(), ev({ kind: "FallbackExecuted", recipient: KID2, ts: Y(2060) })], ctx);
    expect(k).toEqual([expect.objectContaining({ kind: "carriedOutFallback", by: OWNER, about: OWNER, for: [KID2] })]);
  });
});

describe("rule 8: challenges", () => {
  it("an upheld dispute: positive for the raiser, the only negative fact for the claim's beneficiary", () => {
    const k = challenges([...base(), claim("c1", Y(2045)),
      ev({ kind: "DisputeRaised", dispute: "d1", target: "c1", targetKind: "Claim", by: KID2, ts: Y(2045) }),
      ev({ kind: "DisputeResolved", dispute: "d1", target: "c1", targetKind: "Claim", upheld: true, ts: Y(2045, 2) })], ctx);
    expect(k.map((x) => [x.kind, x.by])).toEqual([["raisedUpheldChallenge", KID2], ["challengeUpheld", KID]]);
  });
  it("an upheld objection: positive for the monitor, nothing negative", () => {
    const k = challenges([...base(), claim("c1", Y(2046)),
      ev({ kind: "ObjectionRaised", objection: "o1", target: "c1", targetKind: "Claim", by: MON, ts: Y(2046) }),
      ev({ kind: "ObjectionResolved", objection: "o1", target: "c1", targetKind: "Claim", upheld: true, ts: Y(2046, 2) })], ctx);
    expect(k.map((x) => [x.kind, x.by])).toEqual([["raisedUpheldChallenge", MON]]);
  });
  it("a dismissed (or lapsed) challenge gives nothing to anyone", () => {
    const events = [...base(), claim("c1", Y(2047)),
      ev({ kind: "DisputeRaised", dispute: "d1", target: "c1", targetKind: "Claim", by: KID2, ts: Y(2047) }),
      ev({ kind: "DisputeResolved", dispute: "d1", target: "c1", targetKind: "Claim", upheld: false, ts: Y(2047, 2) }),
      ev({ kind: "ObjectionRaised", objection: "o2", target: "c1", targetKind: "Claim", by: MON, ts: Y(2047) })]; // never resolved: lapsed
    expect(challenges(events, ctx)).toEqual([]);
    expect(keptPromises(events, ctx).filter((k) => k.kind === "challengeUpheld" || k.kind === "raisedUpheldChallenge")).toEqual([]);
  });
});

describe("rule 9: asset paths", () => {
  it("registered → held by the plan at the unlock → passed to an heir; a sale names the person the proceeds went to, never a price", () => {
    const paths = assetPaths([...base(),
      ev({ kind: "AssetRegistered", asset: "car", title: "2017 Toyota Corolla", assetKind: "Car", ts: Y(2026) }),
      ev({ kind: "AssetRegistered", asset: "bike", title: "2025 Big Boy Mustang 250", assetKind: "Motorbike", ts: Y(2026) }),
      ev({ kind: "EstateUnlocked", ts: Y(2041) }),
      ev({ kind: "AssetPassed", asset: "car", to: KID, ts: Y(2041, 6) }),
      ev({ kind: "AssetSold", asset: "bike", recipient: KID2, hardship: true, ts: Y(2042) })], ctx);
    expect(paths.map((p) => [p.kind, p.title, p.owner, p.steps.map((s) => `${s.kind}${s.to ? `>${s.to}` : ""}`)])).toEqual([
      ["Car", "2017 Toyota Corolla", OWNER, ["registered", "heldByPlan", `passedTo>${KID}`]],
      ["Motorbike", "2025 Big Boy Mustang 250", OWNER, ["registered", "heldByPlan", `soldUnderRules>${KID2}`]],
    ]);
  });
  it("a sale whose proceeds went to the estate's vault names nobody", () => {
    const [p] = assetPaths([...base(), ev({ kind: "AssetRegistered", asset: "car", title: "Car", assetKind: "Car", ts: Y(2026) }), ev({ kind: "AssetSold", asset: "car", recipient: E, hardship: false, ts: Y(2042) })], ctx);
    expect(p.steps[1]).toEqual(expect.objectContaining({ kind: "soldUnderRules" }));
    expect(p.steps[1].to).toBeUndefined();
  });
  it("an heir who registers what they received in their own plan continues the same path, across generations", () => {
    const E2 = "Estate2222222222222222222222222222222222222";
    const GRAND = "Grand111111111111111111111111111111111111111";
    const ctx2 = { owners: { [E]: OWNER, [E2]: KID } };
    const paths = assetPaths([...base(),
      ev({ kind: "AssetRegistered", asset: "car", title: "2017 Toyota Corolla", assetKind: "Car", ts: Y(2026) }),
      ev({ kind: "EstateUnlocked", ts: Y(2041) }),
      ev({ kind: "AssetPassed", asset: "car", to: KID, ts: Y(2041, 6) }),
      ev({ estate: E2, kind: "AssetRegistered", asset: "car", title: "2017 Toyota Corolla", assetKind: "Car", ts: Y(2041, 7) }),
      ev({ estate: E2, kind: "EstateUnlocked", ts: Y(2086) }),
      ev({ estate: E2, kind: "AssetPassed", asset: "car", to: GRAND, ts: Y(2086, 5) })], ctx2);
    expect(paths).toHaveLength(1);
    expect(paths[0].owner).toBe(OWNER);
    expect(paths[0].steps.map((s) => `${s.kind}${s.to ? `>${s.to}` : ""}`)).toEqual(
      ["registered", "heldByPlan", `passedTo>${KID}`, "registered", "heldByPlan", `passedTo>${GRAND}`]);
  });
  it("someone else registering the same asset id does not take over its path", () => {
    const E2 = "Estate2222222222222222222222222222222222222";
    const paths = assetPaths([...base(),
      ev({ kind: "AssetRegistered", asset: "car", title: "Car", assetKind: "Car", ts: Y(2026) }),
      ev({ estate: E2, kind: "AssetRegistered", asset: "car", title: "Car", assetKind: "Car", ts: Y(2027) }),
      ev({ estate: E2, kind: "AssetPassed", asset: "car", to: KID2, ts: Y(2028) })], { owners: { [E]: OWNER, [E2]: KID2 } });
    expect(paths[0].steps.map((s) => s.kind)).toEqual(["registered"]);
  });
});

describe("keptPromises", () => {
  it("keeps real and imagined events in separate groups", () => {
    const k = planPaid([...base(), ev({ kind: "ScheduledPaid", rule: "ruleBooks", ts: Y(2026) }), ev({ kind: "ScheduledPaid", rule: "ruleBooks", ts: Y(2027), imagined: true })], ctx);
    expect(k.map((x) => [x.imagined, x.count])).toEqual(expect.arrayContaining([[false, 1], [true, 1]]));
  });
});
