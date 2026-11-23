/** What the screens offer under the second review's rules (plan §18.4): one test for each check, allowed and not. */
import { describe, expect, it } from "vitest";
import type { EstateSnapshot } from "../service/types";
import type { Asset, Claim, Hardship } from "../types";
import { mayAskToList } from "../agent/sale";
import type { FallbackRecipient, GuardiansSnapshot, Seat } from "./types";
import {
  agentVoteFor, agentVotesNeeded, canConfirmRecipient, canConfirmSeat, canReportRecipient, canReportSeat, canSign, canSubmitDeath,
  claimBlock, claimPayable, claimTally, claimVote, deathOpen, deathReplace, deathSince, deathTally, deathVote, hardshipStands,
  hardshipTally, hardshipVote, hasInbox, interestedIn, mayList, NO_WALLET, ownerMayApprove, payoutHeldUntil, reportsAbout, seatReplace, successionOutcome, sweepHeldUntil, wasRemoved,
  agentVoteFrom, agentVoteRule, ownOpenClaim, deathDisproved, reporterKind, votesAlone,
} from "./decisions";

const [A, B, C, KID, SIB, MON, BK1, BK2, AGENT, OWNER] = ["A", "B", "C", "KID", "SIB", "MON", "BK1", "BK2", "AGENT", "OWNER"];

type Over = { estate?: Partial<EstateSnapshot["estate"]>; guardians?: Partial<GuardiansSnapshot> } & Partial<Omit<EstateSnapshot, "estate" | "guardians">>;
function snap({ estate, guardians, ...rest }: Over = {}): EstateSnapshot {
  return {
    estate: {
      address: "E", owner: OWNER, ownerName: "Owner", agent: AGENT, usdtMint: "M", verifiers: [A, B, C], verifierNames: ["A", "B", "C"],
      deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60, status: "Unlocked", willHash: null, vaultBalance: 100n, lastHeartbeat: 1,
      death: { certHash: "cert", submittedBy: KID, verdict: "Approved", attestations: [false, false, false], pendingSince: 100, submittedAt: 50 },
      ...estate,
    },
    beneficiaries: [{ address: "b1", wallet: KID, label: "Kid", active: true }, { address: "b2", wallet: SIB, label: "Sib", active: true }],
    payees: [{ address: "p", wallet: "UNI", kind: "University", name: "Uni" }],
    rules: [{
      address: "R", id: 0, beneficiary: KID, category: "Tuition", allowedPayeeKind: "University", maxPerClaim: 10n, lifetimeCap: 100n, spentTotal: 0n,
      validUntil: 9999, startsNow: true, recurringAmount: 0n, intervalSecs: 0, nextDue: null, fixedPayee: null, claimCount: 1,
    }],
    claims: [], assets: [], offers: [], hardships: [], activity: [],
    guardians: {
      enabled: true, objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120, seats: [], feed: [], objections: [],
      fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
      ...guardians,
    },
    ...rest,
  };
}
const claim = (over: Partial<Claim> = {}): Claim => ({
  address: "CL", rule: "R", id: 0, beneficiary: KID, payee: "UNI", amount: 5n, evidenceHash: "h", agentVerdict: "Approved",
  approvals: [false, false, false], ownerApproved: false, status: "Open", createdAt: 200, ...over,
});
const hardship = (over: Partial<Hardship> = {}): Hardship => ({
  address: "H", asset: "AS", beneficiary: KID, evidenceHash: "h", agentVerdict: "Approved", approvals: [false, false, false], status: "Open", ...over,
});
const active = (over: Partial<EstateSnapshot["estate"]["death"]> = {}) => ({
  status: "Active" as const, death: { ...snap().estate.death, pendingSince: null, ...over },
});
const seat = (over: Partial<Seat> = {}): Seat => ({
  address: "S2", index: 2, holder: C, holderName: "C", backups: [], monitors: [], generation: 0, vacant: false,
  succession: { certHash: "x", reportedBy: SIB, verdict: "Approved", confirmedBy: null, reportedAt: 1000, pendingSince: 0, readyAt: 0, nextHolder: null },
  ...over,
});
const person = (wallet: string) => ({ wallet, name: wallet });
const lastHolder = { verifiers: [NO_WALLET, NO_WALLET, C] as [string, string, string] };

describe("quorums (R8, R11)", () => {
  it("count living, uninterested seats only", () => {
    const s = snap({ estate: { verifiers: [A, NO_WALLET, KID], death: { ...snap().estate.death, attestations: [true, true, true] } } });
    expect(deathTally(s.estate)).toMatchObject({ needed: 1, got: 1, eligible: 1, met: true, votes: [true, false, false] });
  });

  it("are never met by nobody", () => {
    expect(deathTally(snap({ estate: { verifiers: [NO_WALLET, NO_WALLET, NO_WALLET] } }).estate)).toMatchObject({ needed: 0, met: false, eligible: 0 });
  });

  it("don't count approvals from before the death", () => {
    const e = snap().estate;
    expect(claimTally(e, claim({ approvals: [true, false, false] })).met).toBe(true);
    expect(claimTally(e, claim({ approvals: [true, false, false], approvalsCount: false })).met).toBe(false);
  });

  it("hardship takes two, or the only one left", () => {
    expect(hardshipTally(snap().estate, hardship()).needed).toBe(2);
    expect(hardshipTally(snap({ estate: lastHolder }).estate, hardship()).needed).toBe(1);
  });
});

describe("who may sign", () => {
  it("a death: while Active, not whoever reported it", () => {
    const s = snap({ estate: active() });
    expect(deathVote(s.estate, A)).toBe("approve");
    expect(deathVote(s.estate, SIB)).toBeNull();
    expect(deathVote(snap().estate, A)).toBeNull();
    expect(deathVote(snap({ estate: active({ submittedBy: A }) }).estate, A)).toBe("own");
    expect(deathVote(snap({ estate: active({ verdict: "Pending" }) }).estate, A)).toBeNull();
  });

  it("a survivor who voted signs again when that completes a dropped quorum", () => {
    const e = { ...active({ attestations: [true, false, false] }) };
    expect(deathVote(snap({ estate: e }).estate, A)).toBe("waiting");
    const alone = snap({ estate: { ...e, verifiers: [A, NO_WALLET, NO_WALLET] } }).estate;
    expect(deathVote(alone, A)).toBe("complete");
    expect(canSign(deathVote(alone, A))).toBe(true);
  });

  it("a claim: only after the unlock, not the claimant's own", () => {
    expect(claimVote(snap(), claim(), A)).toBe("approve");
    expect(claimVote(snap({ estate: active() }), claim(), A)).toBeNull();
    expect(claimVote(snap({ estate: { verifiers: [KID, B, C] } }), claim(), KID)).toBe("own");
  });

  it("the only trusted person left, who gains, decides alone when the agent approved (never referred, never a hardship)", () => {
    const lone = { verifiers: [A, NO_WALLET, NO_WALLET] as [string, string, string] };
    expect(deathVote(snap({ estate: { ...active({ submittedBy: A }), ...lone } }).estate, A)).toBe("approve");
    expect(deathVote(snap({ estate: { ...active({ submittedBy: A, verdict: "Referred" }), ...lone } }).estate, A)).toBe("own");
    const own = claim({ beneficiary: A });
    const family = [{ address: "bA", wallet: A, label: "A", active: true }];
    expect(claimVote(snap({ estate: lone, beneficiaries: family }), own, A)).toBe("approve");
    expect(claimVote(snap({ estate: lone, beneficiaries: family }), { ...own, agentVerdict: "Referred" }, A)).toBe("own");
    expect(claimTally(snap({ estate: lone }).estate, { ...own, approvals: [true, false, false], decidedAlone: true }).met).toBe(true);
    expect(hardshipVote(snap({ estate: lone }), hardship({ beneficiary: A }), A)).toBe("own");
  });

  it("stale approvals are given again", () => {
    expect(claimVote(snap(), claim({ approvals: [true, false, false], approvalsCount: false }), A)).toBe("again");
  });

  it("a dropped claim quorum is signed again until the window has started", () => {
    const c = claim({ approvals: [true, false, false], agentVerdict: "Referred" });
    const estate = { verifiers: [A, NO_WALLET, NO_WALLET] as [string, string, string] };
    expect(claimVote(snap(), c, A)).toBe("waiting");
    expect(claimVote(snap({ estate }), c, A)).toBe("complete");
    expect(claimVote(snap({ estate, guardians: { claimPayableAt: { CL: 300 } } }), c, A)).toBe("waiting");
  });

  it("a hardship: not a second while one stands (R21), never after the sale", () => {
    const asset = { address: "AS", nftMint: "n", title: "Car", floorPrice: 9n, hardshipFloor: 5n, askingPrice: 10n, proceedsTo: "E", status: "Listed" as const, listingEnds: 500, docHash: "d", hardshipBeneficiary: null as string | null };
    expect(hardshipVote(snap({ assets: [asset] }), hardship(), A)).toBe("approve");
    const standing = snap({ assets: [{ ...asset, hardshipBeneficiary: SIB }] });
    expect(hardshipStands(standing, hardship())).toBe(true);
    expect(hardshipVote(standing, hardship(), A)).toBeNull();
    expect(hardshipVote(snap({ assets: [{ ...asset, status: "Sold" }] }), hardship(), A)).toBeNull();
  });
});

describe("claims that can't be paid (R16, R17)", () => {
  it("says why, and offers no button", () => {
    const cases = [
      ["endedRule", snap(), claim({ fromEndedRule: true })],
      ["endedRule", snap({ rules: [{ ...snap().rules[0], claimCount: 65_536 }] }), claim()],
      ["beneficiary", snap({ beneficiaries: [{ address: "b", wallet: KID, label: "Kid", active: false }] }), claim()],
      ["payee", snap({ payees: [] }), claim()],
      ["expired", snap({ rules: [{ ...snap().rules[0], validUntil: 10 }] }), claim()],
    ] as const;
    for (const [why, s, c] of cases) {
      expect(claimBlock(s, c, 500), why).toBe(why);
      expect(claimVote(s, c, A, 500), why).toBeNull();
      expect(claimPayable(s, { ...c, ownerApproved: true }, 500), why).toBe(false);
      expect(ownerMayApprove({ ...s, estate: { ...s.estate, status: "Active" } }, c, 500), why).toBe(false);
    }
    expect(claimBlock(snap(), claim(), 500)).toBeNull();
  });

  it("pays with a quorum and its window, or the owner's approval", () => {
    const voted = claim({ approvals: [true, false, false] });
    expect(claimPayable(snap(), voted)).toBe(false);
    expect(claimPayable(snap({ guardians: { claimPayableAt: { CL: 300 } } }), voted)).toBe(true);
    expect(claimPayable(snap({ guardians: { enabled: false } }), voted)).toBe(true);
    expect(claimPayable(snap(), claim({ ownerApproved: true }))).toBe(true);
  });
});

describe("proof of life and the death's time", () => {
  it("an open claim is one a check-in cancels", () => {
    expect(deathOpen(snap({ estate: active() }).estate)).toBe(true);
    expect(deathOpen(snap({ estate: active({ certHash: null }) }).estate)).toBe(false);
    expect(deathOpen(snap().estate)).toBe(false);
  });

  it("reads the submission while Active, then when it took effect", () => {
    expect(deathSince(snap({ estate: active() }).estate)).toBe(50);
    expect(deathSince(snap().estate)).toBe(100);
  });
});

describe("replacing a stalled report (R5, R6)", () => {
  it("another family member after the hold, the reporter one grace later", () => {
    const s = snap({ estate: active() });
    expect(deathReplace(s.estate)).toEqual({ others: 170, reporter: 230 });
    expect(canSubmitDeath(s, SIB, 169)).toBe(false);
    expect(canSubmitDeath(s, SIB, 170)).toBe(true);
    expect(canSubmitDeath(s, KID, 170)).toBe(false);
    expect(canSubmitDeath(s, A, 999)).toBe(true); // a trusted person may report it too
    expect(canSubmitDeath(s, AGENT, 999)).toBe(false);
    expect(canSubmitDeath(s, "STRANGER", 999)).toBe(false);
    const listed = snap({ estate: active(), guardians: { fallback: { recipients: [{ wallet: BK2, name: "R", kind: "heir", dead: false }, { wallet: BK1, name: "D", kind: "heir", dead: true }], startedAt: null, readyAt: null, done: false, canStart: false } } });
    expect([canSubmitDeath(listed, BK2, 999), canSubmitDeath(listed, BK1, 999)]).toEqual([true, false]);
  });

  it("a reviewed claim with nobody left stays", () => {
    const s = snap({ estate: { ...active(), verifiers: [NO_WALLET, NO_WALLET, NO_WALLET] } });
    expect(deathReplace(s.estate)).toBeNull();
    expect(canSubmitDeath(s, SIB, 9999)).toBe(false);
  });

  it("a seat's report, until it is confirmed", () => {
    const s = snap();
    expect(canReportSeat(s, seat(), KID, 1359)).toBe(false); // reviewed: RT + 2W (6 x 60 s)
    expect(canReportSeat(s, seat(), KID, 1360)).toBe(true);
    const confirmed = seat({ succession: { ...seat().succession!, confirmedBy: A } });
    expect(seatReplace(s.estate, confirmed)).toBeNull();
    expect(canReportSeat(s, confirmed, KID, 9999)).toBe(false);
  });

  it("participants only", () => {
    const open = seat({ succession: null, monitors: [person(MON)], backups: [person(BK1)] });
    for (const w of [A, OWNER, KID, MON, BK1]) expect(canReportSeat(snap(), open, w, 0), w).toBe(true);
    for (const w of [C, AGENT, "STRANGER"]) expect(canReportSeat(snap(), open, w, 0), w).toBe(false);
  });
});

describe("confirming a trusted person's death (R10, R18)", () => {
  it("another holder, while one is left", () => {
    expect(canConfirmSeat(snap(), seat(), A)).toBe(true);
    expect(canConfirmSeat(snap(), seat(), KID)).toBe(false);
  });

  it("then the second backup or a monitor", () => {
    const s = snap({ estate: lastHolder });
    const x = seat({ backups: [person(BK1), person(BK2)], monitors: [person(MON)] });
    expect(canConfirmSeat(s, x, BK2)).toBe(true);
    expect(canConfirmSeat(s, x, MON)).toBe(true);
    expect(canConfirmSeat(s, x, BK1)).toBe(false);
    expect(canConfirmSeat(s, x, KID)).toBe(false);
  });

  it("then a family member who didn't report it", () => {
    const s = snap({ estate: lastHolder });
    expect(canConfirmSeat(s, seat({ backups: [person(BK1)] }), KID)).toBe(true);
    expect(canConfirmSeat(s, seat(), SIB)).toBe(false);
  });

  it("finalising promotes, clears or empties", () => {
    const e = snap().estate;
    expect(successionOutcome(e, seat({ backups: [person(BK1)] }))).toMatchObject({ kind: "promote", next: { wallet: BK1 } });
    expect(successionOutcome(e, seat({ backups: [person(SIB)] }))).toEqual({ kind: "clear" });
    expect(successionOutcome(e, seat({ backups: [person(A), person(AGENT)] }))).toEqual({ kind: "vacate" });
  });
});

describe("a reported fallback recipient (R4, R20)", () => {
  const report = { reporter: A, certHash: "x", verdict: "Approved" as const, reportedAt: 1000, confirmableAt: 1120 };
  const recipients: FallbackRecipient[] = [{ ...person(KID), kind: "family", dead: false, report }, { ...person(SIB), kind: "family", dead: false }];
  const fallback = { recipients, startedAt: 900, readyAt: 1020, done: false, canStart: false };

  it("a second person confirms: not the reporter, the person or who is next", () => {
    const s = snap({ guardians: { fallback } });
    expect(canConfirmRecipient(s, 0, B)).toBe(true);
    for (const w of [A, KID, SIB, "STRANGER"]) expect(canConfirmRecipient(s, 0, w), w).toBe(false);
  });

  it("the person sees it wherever they land", () => {
    const s = snap({ guardians: { fallback } });
    expect(reportsAbout(s, KID)).toEqual([0]);
    expect(reportsAbout(s, SIB)).toEqual([]);
  });

  it("participants report, again only when stale, never themselves", () => {
    const s = snap({ guardians: { fallback } });
    expect(canReportRecipient(s, 0, B, 1239)).toBe(false);
    expect(canReportRecipient(s, 0, B, 1240)).toBe(true);
    expect(canReportRecipient(s, 1, SIB, 0)).toBe(false);
  });

  it("holds the payout for a bounded time", () => {
    const s = snap({ guardians: { fallback } });
    expect(payoutHeldUntil(s, 1100)).toBe(1240);
    expect(payoutHeldUntil(s, 1240)).toBeNull();
    expect(payoutHeldUntil(snap({ guardians: { fallback: { ...fallback, readyAt: 1000 } } }), 1100)).toBeNull();
  });

  it("holds a sweep that pays by the list", () => {
    expect(sweepHeldUntil(snap({ residual: KID, guardians: { fallback } }), 1100)).toBe(1240);
    expect(sweepHeldUntil(snap({ residual: SIB, guardians: { fallback } }), 1100)).toBeNull();
  });

  it("whoever is paid next gains", () => {
    expect(interestedIn(snap({ guardians: { fallback } }), "Fallback", "G")).toBe(KID);
    expect(interestedIn(snap(), "Unlock", "E")).toBe(KID);
  });
});

describe("replacing the agent", () => {
  it("everyone while Active, at least two; afterwards two, or the only one", () => {
    expect(agentVotesNeeded(snap({ estate: active() }).estate, 100)).toBe(3);
    expect(agentVotesNeeded(snap({ estate: { ...active(), ...lastHolder } }).estate, 100)).toBe(2);
    expect(agentVotesNeeded(snap().estate)).toBe(2);
    expect(agentVotesNeeded(snap({ estate: lastHolder }).estate)).toBe(1);
  });

  it("two before the unlock once an undisproved, still unreviewed death claim and the owner's last sign of life are both RT old", () => {
    const e = snap({ estate: active({ verdict: "Pending" }) }).estate; // claim at 50, last sign of life at 1, W = 60 s: RT = 240 s
    expect(agentVotesNeeded(e, 289)).toBe(3);
    expect(agentVotesNeeded(e, 290)).toBe(2); // max(1, 50) + RT
    expect(agentVotesNeeded({ ...e, lastHeartbeat: 60 }, 9_999)).toBe(3); // disproved: the owner checked in after it
    expect(agentVotesNeeded({ ...e, death: { ...e.death, verdict: "Approved" } }, 9_999)).toBe(3); // reviewed: the agent answered
    expect(agentVotesNeeded({ ...e, status: "DeathPending" }, 100)).toBe(3);
  });

  it("only votes by people who still hold a seat", () => {
    expect(agentVoteFor(snap({ agentVotes: [{ candidate: "N", voters: [A, "GONE"] }] }), "N")).toEqual({ got: 1, needed: 2, voters: [A] });
  });
});

describe("someone the owner removed", () => {
  it("is neither family nor a stranger", () => {
    const s = snap({ beneficiaries: [{ address: "b1", wallet: KID, label: "Kid", active: false }, { address: "b2", wallet: SIB, label: "Sib", active: true }] });
    expect(wasRemoved(s, KID)).toBe(true);
    expect(wasRemoved(s, SIB)).toBe(false);
    expect(wasRemoved(s, MON)).toBe(false);
  });
});

describe("mayList is lib/agent/sale.ts's mayAskToList", () => {
  const car = { address: "AS", floorPrice: 900n, hardshipFloor: 700n } as Asset;
  const cases = [[A, B, C], [NO_WALLET, NO_WALLET, C], [NO_WALLET, NO_WALLET, NO_WALLET]].flatMap((verifiers) =>
    [["Held", null], ["Listed", 999], ["Listed", 1000], ["Listed", 1001], ["Sold", 1]].flatMap(([status, listingEnds]) =>
      [null, KID].flatMap((hardshipBeneficiary) => [[], [699n], [700n], [899n], [900n]].map((amounts) =>
        ({ verifiers, status, listingEnds, hardshipBeneficiary, amounts })))));

  it.each([A, C, KID, SIB, "GONE", MON, NO_WALLET])("the same answer for %s in every case", (me) => {
    for (const c of cases) {
      const asset = { ...car, status: c.status, listingEnds: c.listingEnds, hardshipBeneficiary: c.hardshipBeneficiary } as Asset;
      const offers = c.amounts.map((amount, i) => ({ address: `O${i}`, asset: "AS", buyer: "BUYER", amount, createdAt: 1 }));
      const beneficiaries = [...snap().beneficiaries, { address: "b3", wallet: "GONE", label: "Gone", active: false }];
      const s = snap({ estate: { verifiers: c.verifiers as EstateSnapshot["estate"]["verifiers"] }, beneficiaries, offers });
      expect(mayList(s, asset, me, 1000), JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? String(v) : v)))
        .toBe(mayAskToList(s.estate.verifiers, s.beneficiaries, me, asset, offers, 1000));
    }
  });
});

describe("H9: the owner's no stands after the death", () => {
  const note = { claim: "CL", purpose: "trip", currency: "USDT" as const, typed: 5, createdAt: 1, attachment: false, declinedAt: 10 };
  it("no approval is offered and it can't be paid", () => {
    const c = claim();
    const s = snap({ claims: [c], asks: { CL: note } });
    expect(claimVote(s, c, A)).toBeNull();
    expect(claimPayable(s, { ...c, approvals: [true, false, false] }, 50)).toBe(false);
    expect(claimVote(snap({ claims: [c] }), c, A)).toBe("approve");
  });
});

describe("M10: everyone with something to decide has the inbox", () => {
  it("family who watch, back up or are on the fallback list", () => {
    const seat = { address: "s", index: 0, holder: A, holderName: "A", backups: [{ wallet: SIB, name: "Sib" }], monitors: [{ wallet: KID, name: "Kid" }], generation: 0, vacant: false, succession: null };
    const s = snap({ guardians: { seats: [seat], fallback: { recipients: [{ wallet: MON, name: "M", kind: "family", dead: false }], startedAt: null, readyAt: null, done: false, canStart: false } } });
    expect([hasInbox(s, KID, "beneficiary"), hasInbox(s, SIB, "beneficiary"), hasInbox(s, MON, "beneficiary"), hasInbox(s, A, "owner")]).toEqual([true, true, true, true]);
    expect(hasInbox(s, OWNER, "owner")).toBe(false);
    expect(hasInbox(s, OWNER, "owner", 1)).toBe(true);
  });
});

describe("who reports the owner's passing, in which words (r4 client)", () => {
  const listed = (s: EstateSnapshot["guardians"]) => ({ ...s!, fallback: { ...s!.fallback, recipients: [{ wallet: BK2, name: "R", kind: "heir" as const, dead: false }, { wallet: BK1, name: "D", kind: "heir" as const, dead: true }] } });
  it("family, a trusted person or a living listed recipient; never the agent or a stranger", () => {
    const s = snap({ estate: active({ certHash: null, submittedBy: null }) });
    const l = { ...s, guardians: listed(s.guardians) };
    expect([KID, A, BK2, BK1, AGENT, "STRANGER", OWNER].map((w) => reporterKind(l, w))).toEqual(["family", "trusted", "listed", null, null, null, null]);
    expect([KID, A, BK2, BK1, AGENT, "STRANGER"].map((w) => canSubmitDeath(l, w, 0))).toEqual([true, true, true, false, false, false]);
  });
});

describe("a disproved passing (DeathDisproved)", () => {
  it("the owner showed life after it: nobody confirms it, and anyone who may report replaces it at once, also while DeathPending", () => {
    const pending = snap({ estate: { status: "DeathPending", lastHeartbeat: 150 } }); // death took effect at 100
    expect(deathDisproved(pending.estate)).toBe(true);
    expect([canSubmitDeath(pending, SIB, 0), canSubmitDeath(pending, A, 0), canSubmitDeath(pending, AGENT, 0)]).toEqual([true, true, false]);
    const open = snap({ estate: { ...active(), lastHeartbeat: 60 } }); // claim at 50
    expect(deathDisproved(open.estate)).toBe(true);
    expect(deathVote(open.estate, A)).toBeNull();
    expect(canSubmitDeath(open, KID, 51)).toBe(true); // even the reporter, before any hold
    expect(deathDisproved(snap({ estate: active() }).estate)).toBe(false);
    expect(deathDisproved(snap({ estate: { lastHeartbeat: 999 } }).estate)).toBe(false); // Unlocked
  });
});

describe("decided alone (DECIDED_ALONE)", () => {
  it("only the only trusted person left, who gains, with the agent's approval", () => {
    const lone = { verifiers: [NO_WALLET, NO_WALLET, KID] as [string, string, string] };
    expect(votesAlone(lone, KID, "Approved", KID)).toBe(true);
    expect(votesAlone(lone, KID, "Referred", KID)).toBe(false);
    expect(votesAlone(snap().estate, A, "Approved", A)).toBe(false); // others may decide
    expect(votesAlone(lone, SIB, "Approved", KID)).toBe(false); // doesn't gain
  });
});

describe("the votes to replace the agent, and why", () => {
  it("every held seat before the unlock (DeathPending too), two after it or in the recovery case", () => {
    const e = snap({ estate: active({ verdict: "Pending" }) }).estate;
    expect(agentVoteRule(e, 100)).toEqual({ needed: 3, why: "all", recoveryAt: 290 });
    expect(agentVoteRule(e, 290)).toEqual({ needed: 2, why: "recovery" });
    expect(agentVoteRule({ ...e, death: { ...e.death, verdict: "Approved" } }, 290)).toEqual({ needed: 3, why: "all" });
    expect(agentVoteRule(snap().estate)).toEqual({ needed: 2, why: "after" });
    expect(agentVoteFor(snap({ estate: active({ verdict: "Pending" }), agentVotes: [{ candidate: "N", voters: [A, B] }] }), "N", 290)).toMatchObject({ got: 2, needed: 2 });
  });

  it("the only trusted person left who would gain waits twice RT", () => {
    const lone = { verifiers: [NO_WALLET, NO_WALLET, KID] as [string, string, string] };
    // Before the unlock: Kid reported it (claim at 50, sign of life at 1): from max(1, 50) + 2 RT.
    const pending = snap({ estate: { ...active({ verdict: "Pending" }), ...lone } });
    expect(agentVoteFrom(pending, KID)).toBe(530);
    expect(agentVoteFrom({ ...pending, estate: { ...pending.estate, death: { ...pending.estate.death, submittedBy: SIB } } }, KID)).toBe(530); // any active beneficiary gains
    const outsider = snap({ estate: { ...active({ verdict: "Pending", submittedBy: SIB }), verifiers: [NO_WALLET, NO_WALLET, A] } });
    expect(agentVoteFrom(outsider, A)).toBeNull(); // neither reported it nor is family
    expect(agentVoteFrom({ ...outsider, estate: { ...outsider.estate, death: { ...outsider.estate.death, submittedBy: A } } }, A)).toBe(530); // reported it
    expect(agentVoteFrom(snap({ estate: active({ verdict: "Pending" }) }), A)).toBeNull(); // others hold seats
    // After the unlock: from their open claim's submission while the agent hasn't approved it.
    const after = snap({ estate: lone, claims: [claim({ agentVerdict: "Referred", createdAt: 200 })] });
    expect(agentVoteFrom(after, KID)).toBe(200 + 480);
    expect(agentVoteFrom({ ...after, claims: [claim({ agentVerdict: "Approved" })] }, KID)).toBe(Number.POSITIVE_INFINITY); // approved: no stuck claim
    expect(agentVoteFrom(snap({ estate: lone }), KID)).toBe(Number.POSITIVE_INFINITY); // no claim: never alone
    expect(agentVoteFrom(snap({ estate: lone, hardships: [hardship()] }), KID)).toBe(Number.POSITIVE_INFINITY); // a hardship starts no clock
    expect(agentVoteFrom(snap({ estate: { verifiers: [NO_WALLET, NO_WALLET, A] } }), A)).toBeNull(); // not family: no wait
    const mine = [claim({ address: "OK", createdAt: 50 }), claim({ address: "OLD", createdAt: 100, agentVerdict: "Referred" }), claim({ address: "NEW", createdAt: 300, agentVerdict: "Referred" }), claim({ address: "PAID", createdAt: 10, status: "Paid", agentVerdict: "Referred" })];
    expect(ownOpenClaim(mine, KID)?.address).toBe("OLD"); // the earliest the agent hasn't approved
  });
});

describe("an unreviewed death claim is never replaced (re-review)", () => {
  it("it waits for the agent's review; a disproved one is replaced at once", () => {
    const s = snap({ estate: active({ verdict: "Pending" }) });
    expect(deathReplace(s.estate)).toEqual({ others: Number.POSITIVE_INFINITY, reporter: Number.POSITIVE_INFINITY });
    expect([canSubmitDeath(s, SIB, 9e9), canSubmitDeath(s, A, 9e9)]).toEqual([false, false]);
    expect(canSubmitDeath({ ...s, estate: { ...s.estate, lastHeartbeat: 60 } }, SIB, 51)).toBe(true);
  });
});
