import { describe, expect, it } from "vitest";
import type { EstateSnapshot } from "@/lib/service";
import { NO_WALLET } from "@/lib/guardians/decisions";
import type { GuardiansSnapshot, Objection, Seat, SeatApprovalItem } from "@/lib/guardians/types";
import {
  afterReplacement, allVacant, canConfirm, checkReplacement, canObject, canReport, checkFallback, checkPeople, clock, fallbackStage, fallbackWinner, feedFor,
  guardianTodo, heldSeat, isMonitor, mayRaise, monitorPending, moveItem, pausedBy, secondsLeft, shortName, successionStage, voterRole,
  waitFraction, waitUnit,
} from "./derive";

const W = (c: string) => c.repeat(32).slice(0, 32) + "1234"; // looks like a base58 wallet
const OWNER = W("P"), THANDI = W("T"), ANITA = W("A"), BONGANI = W("B"), KAGISO = W("K"), NAIDOO = W("N"), ZODWA = W("Z"), LERATO = W("L");

function seat(index: number, holder: string | null, extra: Partial<Seat> = {}): Seat {
  return { address: W(String(index + 1)), index, holder, holderName: holder ? `Holder ${index}` : "", backups: [], monitors: [], generation: 0, vacant: holder === null, succession: null, ...extra };
}

function guard(over: Partial<GuardiansSnapshot> = {}): GuardiansSnapshot {
  return {
    enabled: true, objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120,
    seats: [
      seat(0, THANDI), seat(1, ANITA),
      seat(2, BONGANI, { holderName: "Uncle Bongani Mokoena", backups: [{ wallet: KAGISO, name: "Kagiso" }, { wallet: NAIDOO, name: "Adv. Naidoo" }], monitors: [{ wallet: ZODWA, name: "Aunt Zodwa" }] }),
    ],
    feed: [], objections: [],
    fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
    ...over,
  };
}

/** A snapshot around a guard: the trusted people are its holders, Lerato the family. */
const snap = (status: "Active" | "Unlocked" = "Active", g: GuardiansSnapshot = guard()) => ({
  estate: {
    owner: OWNER, agent: W("G"), status, waitingPeriodSecs: 60, verifiers: g.seats.map((s) => s.holder ?? NO_WALLET),
    death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [], pendingSince: null },
  },
  beneficiaries: [{ address: W("R"), wallet: LERATO, label: "Lerato", active: true }],
  claims: [], hardships: [], disputes: [],
  guardians: g,
} as unknown as EstateSnapshot);

const item = (over: Partial<SeatApprovalItem> = {}): SeatApprovalItem => ({
  seatIndex: 2, approver: BONGANI, approverName: "Uncle Bongani", kind: "Claim", target: W("C"), summary: "Approved 3 500 USD₮", ts: 1000, objectionDeadline: 1060, ...over,
});

const objection = (over: Partial<Objection> = {}): Objection => ({
  address: W("X"), kind: "Claim", target: W("C"), monitor: ZODWA, monitorName: "Aunt Zodwa Mokoena", seatIndex: 2, reason: "Too much",
  reasonHash: "ab", raisedAt: 1010, status: "Open", votesUphold: 0, votesDismiss: 0, ...over,
});

describe("names", () => {
  it("keeps a title with the first name", () => {
    expect(shortName("Uncle Bongani Mokoena")).toBe("Uncle Bongani");
    expect(shortName("Adv. Thandi Ndlovu")).toBe("Adv. Ndlovu");
    expect(shortName("Lerato Mokoena (daughter)")).toBe("Lerato");
    expect(shortName("Kagiso")).toBe("Kagiso");
  });
});

describe("monitors and the feed", () => {
  it("finds what a monitor watches and only their feed", () => {
    const g = guard({ feed: [item({ ts: 5 }), item({ seatIndex: 0, target: W("D") }), item({ ts: 9, target: W("E") })] });
    expect(isMonitor(g, ZODWA)).toBe(true);
    expect(isMonitor(g, LERATO)).toBe(false);
    expect(feedFor(g, ZODWA).map((f) => f.ts)).toEqual([9, 5]);
  });

  it("allows an objection only inside the window and only once", () => {
    const g = guard();
    expect(canObject(g, item(), 1059)).toBe(true);
    expect(canObject(g, item(), 1060)).toBe(false);
    expect(canObject(g, item(), null)).toBe(false);
    expect(canObject(g, item({ objectionDeadline: null }), null)).toBe(true);
    expect(canObject(guard({ objections: [objection({ status: "Dismissed" })] }), item(), 1000)).toBe(false);
  });

  it("counts what a monitor can still act on", () => {
    const g = guard({ feed: [item(), item({ target: W("F"), objectionDeadline: 900 })] });
    expect(monitorPending(g, ZODWA, 1000)).toBe(1);
    expect(monitorPending(g, LERATO, 1000)).toBe(0);
  });

  it("shows a target as paused only while its objection is open", () => {
    expect(pausedBy(guard({ objections: [objection()] }), W("C"))?.monitorName).toBe("Aunt Zodwa Mokoena");
    expect(pausedBy(guard({ objections: [objection({ status: "Upheld" })] }), W("C"))).toBeNull();
    expect(pausedBy(guard(), W("C"))).toBeNull();
  });
});

describe("who votes on an objection", () => {
  const g = guard({ objections: [objection()] });
  it("the owner decides alone while the estate is active", () => {
    expect(voterRole(g, objection(), snap("Active"), OWNER)).toBe("owner");
    expect(voterRole(g, objection(), snap("Unlocked"), OWNER)).toBeNull();
  });
  it("other holders vote; the watched holder and outsiders don't", () => {
    expect(voterRole(g, objection(), snap(), THANDI)).toBe("holder");
    expect(voterRole(g, objection(), snap(), BONGANI)).toBeNull();
    expect(voterRole(g, objection(), snap(), ZODWA)).toBeNull();
    expect(voterRole(g, objection({ status: "Dismissed" }), snap(), THANDI)).toBeNull();
  });
});

describe("succession", () => {
  const pending = (over: Partial<NonNullable<Seat["succession"]>> = {}) => ({
    certHash: "aa", reportedBy: LERATO, verdict: "Approved" as const, confirmedBy: null, pendingSince: 100, readyAt: 160, nextHolder: { wallet: KAGISO, name: "Kagiso" }, ...over,
  });
  const withSeat = (s: Seat) => guard({ seats: [seat(0, THANDI), seat(1, ANITA), s] });

  it("walks through the stages", () => {
    const base = guard().seats[2];
    expect(successionStage(base, 0)).toBe("none");
    expect(successionStage({ ...base, succession: pending({ verdict: "Pending" }) }, 0)).toBe("reviewing");
    expect(successionStage({ ...base, succession: pending({ verdict: "Rejected" }) }, 0)).toBe("rejected");
    expect(successionStage({ ...base, succession: pending() }, 0)).toBe("confirm");
    expect(successionStage({ ...base, succession: pending({ confirmedBy: THANDI }) }, 159)).toBe("waiting");
    expect(successionStage({ ...base, succession: pending({ confirmedBy: THANDI }) }, 160)).toBe("ready");
  });

  it("only another living holder confirms; never the reporter, the holder or the first backup", () => {
    const s = { ...guard().seats[2], succession: pending() };
    const g = withSeat(s);
    expect(canConfirm(snap("Active", g), s, THANDI)).toBe(true);
    expect(canConfirm(snap("Active", g), s, BONGANI)).toBe(false);
    expect(canConfirm(snap("Active", g), s, LERATO)).toBe(false);
    expect(canConfirm(snap("Active", g), s, KAGISO)).toBe(false);
    expect(canConfirm(snap("Active", g), s, ZODWA)).toBe(false);
    expect(canConfirm(snap("Active", g), { ...s, succession: pending({ verdict: "Pending" }) }, THANDI)).toBe(false);
  });

  it("with no other living holder, the second backup or a monitor confirms", () => {
    const s = { ...guard().seats[2], succession: pending() };
    const g = guard({ seats: [seat(0, null), seat(1, null), s] });
    expect(canConfirm(snap("Active", g), s, NAIDOO)).toBe(true);
    expect(canConfirm(snap("Active", g), s, ZODWA)).toBe(true);
    expect(canConfirm(snap("Active", g), s, KAGISO)).toBe(false);
  });

  it("only participants report, never the holder, and again only when the report is stale", () => {
    const s = guard().seats[2];
    expect(canReport(snap(), s, LERATO, 0)).toBe(true);
    expect(canReport(snap(), s, ZODWA, 0)).toBe(true);
    expect(canReport(snap(), s, BONGANI, 0)).toBe(false);
    expect(canReport(snap(), s, W("S"), 0)).toBe(false);
    const reported = { ...s, succession: { ...pending(), reportedBy: THANDI, reportedAt: 1000 } };
    expect(canReport(snap(), reported, LERATO, 1359)).toBe(false); // reviewed: RT + 2W
    expect(canReport(snap(), reported, LERATO, 1360)).toBe(true);
    expect(canReport(snap(), seat(0, null), LERATO, 0)).toBe(false);
  });

  it("finds the seat a wallet holds", () => {
    expect(heldSeat(guard(), BONGANI)?.index).toBe(2);
    expect(heldSeat(guard(), ZODWA)).toBeNull();
  });
});

describe("fallback plan", () => {
  const vacant = [seat(0, null), seat(1, null), seat(2, null)];
  const recipients = [
    { wallet: LERATO, name: "Lerato", kind: "family" as const, dead: true },
    { wallet: KAGISO, name: "Sipho", kind: "family" as const, dead: false },
  ];
  it("is not needed while any place is filled", () => {
    expect(allVacant(guard())).toBe(false);
    expect(fallbackStage(guard(), 0)).toBe("notNeeded");
    expect(fallbackStage(null, 0)).toBe("notNeeded");
  });
  it("waits for the owner's passing, then can start, counts down, executes, is done", () => {
    const f = guard().fallback;
    expect(fallbackStage(guard({ seats: vacant }), 0)).toBe("waitingOwner");
    expect(fallbackStage(guard({ seats: vacant, fallback: { ...f, canStart: true } }), 0)).toBe("ready");
    const started = { ...f, canStart: true, startedAt: 100, readyAt: 220 };
    expect(fallbackStage(guard({ seats: vacant, fallback: started }), 219)).toBe("counting");
    expect(fallbackStage(guard({ seats: vacant, fallback: started }), 220)).toBe("executable");
    expect(fallbackStage(guard({ seats: vacant, fallback: { ...started, done: true } }), 0)).toBe("done");
  });
  it("pays the first recipient who is still alive", () => {
    expect(fallbackWinner({ ...guard().fallback, recipients })?.recipient.name).toBe("Sipho");
    expect(fallbackWinner({ ...guard().fallback, recipients: [recipients[0]] })).toBeNull();
  });
});

describe("timers", () => {
  it("counts down and fills", () => {
    expect(secondsLeft(160, 100)).toBe(60);
    expect(secondsLeft(160, 200)).toBe(0);
    expect(secondsLeft(null, 1)).toBeNull();
    expect(waitFraction(160, 60, 130)).toBe(0.5);
    expect(waitFraction(160, 60, 999)).toBe(1);
    expect(clock(90)).toBe("1:30");
    expect(clock(3 * 86400 + 7200)).toBe("3d 2h");
  });
  it("picks a unit for a wait", () => {
    expect(waitUnit(90 * 86400)).toEqual({ unit: "days", n: 90 });
    expect(waitUnit(120)).toEqual({ unit: "minutes", n: 2 });
    expect(waitUnit(60)).toEqual({ unit: "seconds", n: 60 });
  });
});

describe("editors", () => {
  it("moves an item", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });

  it("checks backups and monitors like the program", () => {
    const s = guard().seats[2];
    const holders = guard().seats.map((x) => x.holder);
    const ctx = { kind: "backups" as const, seat: s, owner: OWNER, holders };
    expect(checkPeople([{ name: "Kagiso", wallet: KAGISO }], ctx)).toBeNull();
    expect(checkPeople([{ name: "", wallet: KAGISO }], ctx)?.error).toBe("name");
    expect(checkPeople([{ name: "x", wallet: "nope" }], ctx)?.error).toBe("wallet");
    expect(checkPeople([{ name: "a", wallet: KAGISO }, { name: "b", wallet: KAGISO }], ctx)).toEqual({ row: 1, error: "duplicate" });
    expect(checkPeople([{ name: "b", wallet: BONGANI }], ctx)?.error).toBe("holder");
    expect(checkPeople([{ name: "o", wallet: OWNER }], ctx)?.error).toBe("owner");
    expect(checkPeople([{ name: "t", wallet: THANDI }], ctx)?.error).toBe("otherHolder");
    // A watcher may be another trusted person, but never the person they watch.
    expect(checkPeople([{ name: "t", wallet: THANDI }], { ...ctx, kind: "monitors" })).toBeNull();
    expect(checkPeople([{ name: "b", wallet: BONGANI }], { ...ctx, kind: "monitors" })?.error).toBe("holder");
    expect(checkPeople([{ name: "a", wallet: KAGISO }, { name: "b", wallet: NAIDOO }, { name: "c", wallet: ZODWA }], ctx)?.error).toBe("tooMany");
  });

  it("checks the fallback list", () => {
    expect(checkFallback([])?.error).toBe("empty");
    expect(checkFallback([{ name: "Lerato", wallet: LERATO, kind: "family" }])).toBeNull();
    expect(checkFallback(Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, wallet: W(String(i + 1)), kind: "charity" as const })))?.error).toBe("tooMany");
  });
});

describe("inbox count", () => {
  it("adds votes, confirmations, 'I'm still here' and the monitor's feed", () => {
    const s2 = { ...guard().seats[2], succession: { certHash: "aa", reportedBy: LERATO, verdict: "Approved" as const, confirmedBy: null, pendingSince: 0, readyAt: 60, nextHolder: null } };
    const g = guard({ seats: [seat(0, THANDI), seat(1, ANITA), s2], objections: [objection()], feed: [item({ target: W("G") })] });
    const s = snap("Active", g);
    expect(guardianTodo(g, s, THANDI, 1000)).toBe(2); // vote + confirm
    expect(guardianTodo(g, s, BONGANI, 1000)).toBe(1); // I'm still here
    expect(guardianTodo(g, s, ZODWA, 1000)).toBe(1);   // feed item
    expect(guardianTodo(null, s, THANDI, 1000)).toBe(0);
  });
});

describe("replacing a trusted person (owner_replace_seat)", () => {
  const holders = guard().seats.map((s) => s.holder);
  const ctx = { owner: OWNER, holders };
  it("needs a name and a wallet", () => {
    expect(checkReplacement({ name: " ", wallet: LERATO }, ctx)).toBe("name");
    expect(checkReplacement({ name: "Lerato", wallet: "nope" }, ctx)).toBe("wallet");
  });
  it("never the owner, never anyone holding a place (this one included): DuplicateVerifier", () => {
    expect(checkReplacement({ name: "Thabo", wallet: OWNER }, ctx)).toBe("owner");
    expect(checkReplacement({ name: "Thandi", wallet: THANDI }, ctx)).toBe("holder");
    expect(checkReplacement({ name: "Bongani", wallet: ` ${BONGANI} ` }, ctx)).toBe("holder");
  });
  it("a backup, a monitor or a new person is fine; an empty place does not count as a holder", () => {
    expect(checkReplacement({ name: "Kagiso", wallet: KAGISO }, ctx)).toBeNull();
    expect(checkReplacement({ name: "Zodwa", wallet: ZODWA }, ctx)).toBeNull();
    expect(checkReplacement({ name: "Lerato", wallet: LERATO }, { owner: OWNER, holders: [null, ANITA, BONGANI] })).toBeNull();
  });
  it("shows the lists after the swap: the new holder leaves this place's backups and monitors", () => {
    const s = guard().seats[2];
    expect(afterReplacement(s, LERATO)).toMatchObject({ removed: false, backups: s.backups, monitors: s.monitors });
    expect(afterReplacement(s, KAGISO)).toMatchObject({ removed: true, backups: [{ wallet: NAIDOO, name: "Adv. Naidoo" }] });
    expect(afterReplacement(s, ZODWA)).toMatchObject({ removed: true, monitors: [] });
  });
});

describe("objections after the second review", () => {
  const C1 = W("C"), NOW = 2000;
  /** One open claim of Lerato's, or a death Lerato reported, with what was raised before. */
  const at = (status: "Active" | "Unlocked", objections: Objection[] = [], since = 900, g: Partial<GuardiansSnapshot> = {}) => {
    const s = snap(status, guard({ objections, ...g }));
    s.claims = [{ address: C1, beneficiary: LERATO, status: "Open" }] as EstateSnapshot["claims"];
    s.estate.death = { ...s.estate.death, certHash: "cert", submittedBy: LERATO, submittedAt: since, pendingSince: status === "Active" ? null : since };
    return s;
  };

  it("a monitor may challenge once; never the person who gains", () => {
    expect(mayRaise(at("Unlocked"), "Claim", C1, ZODWA, NOW)).toBe(true);
    expect(mayRaise(at("Unlocked"), "Claim", C1, LERATO, NOW)).toBe(false);
    expect(mayRaise(at("Active"), "Unlock", W("E"), LERATO, NOW)).toBe(false);
    expect(mayRaise(at("Unlocked", [objection({ status: "Dismissed" })]), "Claim", C1, ZODWA, NOW)).toBe(false);
  });
  it("again for another death, or after the earlier one was upheld", () => {
    expect(mayRaise(at("Unlocked", [objection({ status: "Upheld" })]), "Claim", C1, ZODWA, NOW)).toBe(true);
    expect(mayRaise(at("Unlocked", [objection({ status: "Dismissed", raisedAt: 500 })]), "Claim", C1, ZODWA, NOW)).toBe(true);
    const unlock = (raisedAt: number) => at("Active", [objection({ kind: "Unlock", target: W("E"), status: "Dismissed", raisedAt })]);
    expect(mayRaise(unlock(500), "Unlock", W("E"), ZODWA, NOW)).toBe(true);
    expect(mayRaise(unlock(1010), "Unlock", W("E"), ZODWA, NOW)).toBe(false);
  });
  it("never a second time on a hardship request, and on a fallback only for a later countdown", () => {
    expect(mayRaise(at("Unlocked", [objection({ kind: "Hardship", status: "Dismissed", raisedAt: 500 })]), "Hardship", C1, ZODWA, NOW)).toBe(false);
    const started = (startedAt: number) => at("Unlocked", [objection({ kind: "Fallback", target: W("F"), status: "Dismissed" })], 900,
      { fallback: { recipients: [], startedAt, readyAt: startedAt + 120, done: false, canStart: false } });
    expect(mayRaise(started(1500), "Fallback", W("F"), ZODWA, NOW)).toBe(true);
    expect(mayRaise(started(1000), "Fallback", W("F"), ZODWA, NOW)).toBe(false);
  });

  it("a lapsed or voided objection pauses nothing and takes no vote", () => {
    const o = objection({ lapsesAt: 1500 });
    const g = guard({ objections: [o] });
    expect(pausedBy(g, o.target, 1499)).toBe(o);
    expect(pausedBy(g, o.target, 1500)).toBeNull();
    expect(voterRole(g, o, snap("Unlocked", g), THANDI, 1499)).toBe("holder");
    expect(voterRole(g, o, snap("Unlocked", g), THANDI, 1500)).toBeNull();
  });
  it("on the fallback the monitors vote, never whoever raised it and never a holder for it", () => {
    const g = guard({ seats: [seat(0, THANDI, { monitors: [{ wallet: KAGISO, name: "Kagiso" }, { wallet: ZODWA, name: "Zodwa" }] }), seat(1, ANITA), seat(2, BONGANI)] });
    const o = objection({ kind: "Fallback", seatIndex: null });
    expect(voterRole(g, o, snap("Unlocked", g), KAGISO)).toBe("monitor");
    expect(voterRole(g, o, snap("Unlocked", g), ZODWA)).toBeNull();
    expect(voterRole(g, o, snap("Unlocked", g), THANDI)).toBeNull();
  });
});

describe("the agent never takes a trusted person's place", () => {
  it("refuses the agent's wallet, not somebody else's", () => {
    const ctx = { owner: OWNER, holders: [THANDI, ANITA, BONGANI], agent: W("G") };
    expect(checkReplacement({ name: "Agent", wallet: W("G") }, ctx)).toBe("agent");
    expect(checkReplacement({ name: "Kagiso", wallet: KAGISO }, ctx)).toBeNull();
  });
});
