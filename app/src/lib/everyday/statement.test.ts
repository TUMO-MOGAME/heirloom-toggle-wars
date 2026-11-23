import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { activityFrom } from "../chain/reads";
import { createMockService, DEMO_PERSONAS } from "../service/mock";
import type { EstateSnapshot } from "../service/types";
import type { ActivityItem, Rule } from "../types";
import { toBase } from "../format";
import { buildStatement, monthKey, monthRange, shiftMonth, statementMonths, upcoming } from "./statement";

const LERATO = "6ckEzZLHJ4XLXLP7jrkjFau22cK8KhV2cVeWyhqJmSWm";
const NALEDI = "3Shi7YitQt1uDDnmfGbL9EEkespgos2QpCDaph5Go2at";
const UNI = "6veGKXYUDGqBDjrP4137igAiMWpRHiwiGCUH8ssjKU8z";
const SHOP = "VaNs5cHaIkBoOkStOrEbRaAmFoNtEiNg8uE6rAoPaY55";
const SCHOOL = "MoRr3iSiSaAcSoNhIgHsChOoLsOwEtOg8uE6rAoPaY3";
const at = (iso: string) => Date.parse(iso) / 1000;

function rule(over: Partial<Rule>): Rule {
  return {
    address: "rule", id: 0, beneficiary: LERATO, category: "Books", allowedPayeeKind: "Other", maxPerClaim: toBase(100), lifetimeCap: toBase(3000),
    spentTotal: BigInt(0), validUntil: at("2030-12-31T00:00:00Z"), startsNow: true, recurringAmount: BigInt(0), intervalSecs: 0, nextDue: null, fixedPayee: null,
    ...over,
  };
}

function snapshot(over: Partial<EstateSnapshot> = {}): EstateSnapshot {
  return {
    estate: { address: "estate", status: "Active" } as EstateSnapshot["estate"],
    beneficiaries: [], payees: [], claims: [], assets: [], offers: [], hardships: [],
    rules: [
      rule({ address: "books", category: "Books", recurringAmount: toBase(85), intervalSecs: 30 * 86400, nextDue: at("2026-12-05T08:00:00+02:00"), fixedPayee: SHOP }),
      rule({ address: "uni", category: "Tuition", allowedPayeeKind: "University" }),
      rule({ address: "school", beneficiary: NALEDI, category: "Tuition", allowedPayeeKind: "School", startsNow: false, recurringAmount: toBase(500), intervalSecs: 91 * 86400, fixedPayee: SCHOOL }),
    ],
    activity: [],
    ...over,
  };
}

const paid = (ts: number, amount: number, payment: ActivityItem["payment"], kind = "ScheduledPaid"): ActivityItem =>
  ({ ts, kind, text: "paid", amount: toBase(amount), txSignature: `sig${ts}`, payment });

describe("statement months (Africa/Johannesburg)", () => {
  it("puts a payment in the South African month, whatever the UTC date says", () => {
    // 22:30 UTC on 31 October is 00:30 on 1 November in Johannesburg.
    expect(monthKey(at("2026-10-31T22:30:00Z"))).toBe("2026-11");
    expect(monthKey(at("2026-10-31T21:59:59Z"))).toBe("2026-10");
    expect(monthKey(at("2026-12-31T23:00:00+02:00"))).toBe("2026-12");
  });
  it("runs from midnight on the 1st to midnight on the next 1st, across a year end", () => {
    expect(monthRange("2026-11")).toEqual({ start: at("2026-11-01T00:00:00+02:00"), end: at("2026-12-01T00:00:00+02:00") });
    expect(monthRange("2026-12").end).toBe(at("2027-01-01T00:00:00+02:00"));
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
  it("lists every month from the first activity to now, newest first", () => {
    const acts = [paid(at("2026-09-20T10:00:00+02:00"), 1, undefined)];
    expect(statementMonths(acts, at("2026-11-15T10:00:00+02:00"))).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(statementMonths([], at("2026-11-15T10:00:00+02:00"))).toEqual(["2026-11"]);
  });
});

describe("buildStatement", () => {
  const snap = snapshot({
    claims: [{ address: "claim1", rule: "uni", id: 0, beneficiary: LERATO, payee: UNI, amount: toBase(3500), evidenceHash: "", agentVerdict: "Approved", approvals: [], ownerApproved: true, status: "Paid", createdAt: 0, txSignature: "sigclaim" }],
    activity: [
      { ts: at("2026-12-01T00:00:00+02:00"), kind: "ScheduledPaid", text: "next month", amount: toBase(85), payment: { payee: SHOP, rule: "books" } },
      paid(at("2026-11-30T23:59:59+02:00"), 85, { payee: SHOP, rule: "books" }),
      { ts: at("2026-11-10T12:00:00+02:00"), kind: "ClaimPaid", text: "3,500 USD₮ paid", amount: toBase(3500), txSignature: "sigclaim" },
      paid(at("2026-11-01T00:00:00+02:00"), 85, { payee: SHOP, rule: "books" }),
      { ts: at("2026-11-02T09:00:00+02:00"), kind: "Deposit", text: "added", amount: toBase(5000) },
      paid(at("2026-10-31T23:59:59+02:00"), 85, { payee: SHOP, rule: "books" }),
      { ts: at("2026-09-01T09:00:00+02:00"), kind: "EstateCreated", text: "created" },
    ],
  });

  it("keeps only vault payments inside the month's boundaries, oldest first", () => {
    const s = buildStatement(snap, "2026-11");
    expect(s.lines.map((l) => l.ts)).toEqual([at("2026-11-01T00:00:00+02:00"), at("2026-11-10T12:00:00+02:00"), at("2026-11-30T23:59:59+02:00")]);
    expect(s.complete).toBe(true);
  });

  it("names the payee, the person and the purpose from the rule (claims by their transaction too)", () => {
    const [first, claim] = buildStatement(snap, "2026-11").lines;
    expect(first).toMatchObject({ payee: SHOP, person: LERATO, purpose: "Books", scheduled: true, rule: "books" });
    expect(claim).toMatchObject({ person: LERATO, purpose: "Tuition", scheduled: false, rule: "uni" });
  });

  it("totals the month, per purpose and per person", () => {
    const s = buildStatement(snap, "2026-11");
    expect(s.total).toBe(toBase(3670));
    expect(s.byPurpose).toEqual([{ key: "Tuition", amount: toBase(3500), count: 1 }, { key: "Books", amount: toBase(170), count: 2 }]);
    expect(s.byPerson).toEqual([{ key: LERATO, amount: toBase(3670), count: 3 }]);
    expect(buildStatement(snap, "2026-08").total).toBe(BigInt(0));
  });

  it("counts the fallback plan as paid to its recipient, and an unknown rule as unknown", () => {
    const s = buildStatement(snapshot({ activity: [
      paid(at("2026-11-05T10:00:00+02:00"), 1000, { payee: NALEDI }, "FallbackExecuted"),
      paid(at("2026-11-06T10:00:00+02:00"), 40, { payee: UNI, rule: "gone" }, "ClaimPaid"),
    ] }), "2026-11");
    expect(s.lines[0]).toMatchObject({ purpose: "Fallback", person: NALEDI, payee: NALEDI });
    expect(s.lines[1]).toMatchObject({ purpose: "Unknown", person: null, payee: UNI });
  });

  it("says when the loaded feed may not reach back to the start of the month", () => {
    const partial = snapshot({ activity: [paid(at("2026-11-20T10:00:00+02:00"), 85, { payee: SHOP, rule: "books" })] });
    expect(buildStatement(partial, "2026-11").complete).toBe(false);
    expect(buildStatement(partial, "2026-12").complete).toBe(true);
  });

  it("reads devnet events: ClaimPaid and ScheduledPaid carry the payee and rule", () => {
    const pk = (s: string) => new PublicKey(s);
    const SHOP = "GpufgMWp8sgFEYgaJ1XoEu42JG7pKVBD4kfaDbohp8rM", SCHOOL = "ALpw94XmFYogivyVbrHq1NGuvY5fqxryyqkxmbiiRtHm";
    const items = activityFrom([
      { name: "ScheduledPaid", ts: at("2026-11-03T10:00:00+02:00"), signature: "s1", data: { estate: pk(UNI), rule: pk(NALEDI), payee: pk(SHOP), amount: "85000000", next_due: "0", ts: "0" } },
      { name: "ClaimPaid", ts: at("2026-11-04T10:00:00+02:00"), signature: "s2", data: { estate: pk(UNI), rule: pk(LERATO), claim: pk(SCHOOL), payee: pk(UNI), amount: "350000000", ts: "0" } },
    ] as Parameters<typeof activityFrom>[0]);
    expect(items[0].payment).toEqual({ payee: SHOP, rule: NALEDI });
    expect(items[1].payment).toEqual({ payee: UNI, rule: LERATO, claim: SCHOOL });
  });
});

describe("upcoming (scheduled next month)", () => {
  it("counts a living schedule's due dates in the month; legacy schedules wait for the unlock", () => {
    const list = upcoming(snapshot(), "2026-12");
    expect(list).toEqual([{ rule: "books", payee: SHOP, person: LERATO, purpose: "Books", amount: toBase(85), count: 1, total: toBase(85), firstDue: at("2026-12-05T08:00:00+02:00") }]);
    // 30-day interval from 5 Dec: 4 Jan falls in January, 3 Feb does not.
    expect(upcoming(snapshot(), "2027-01")[0]).toMatchObject({ count: 1, firstDue: at("2027-01-04T08:00:00+02:00") });
  });

  it("after the unlock, includes every schedule and stops at what is left under the total", () => {
    const s = snapshot({ estate: { address: "e", status: "Unlocked" } as EstateSnapshot["estate"] });
    s.rules[0] = { ...s.rules[0], intervalSecs: 7 * 86400, spentTotal: toBase(3000 - 170) }; // weekly, room for 2 more
    const list = upcoming(s, "2026-12");
    expect(list.find((l) => l.rule === "books")).toMatchObject({ count: 2, total: toBase(170) });
    expect(list.find((l) => l.rule === "school")).toMatchObject({ count: 1, person: NALEDI });
  });

  it("skips ended and spent rules, and counts the demo clock (every minute) once a month", () => {
    const s = snapshot();
    s.rules[0] = { ...s.rules[0], validUntil: at("2026-11-20T00:00:00Z") };
    expect(upcoming(s, "2026-12")).toEqual([]);
    s.rules[0] = { ...s.rules[0], validUntil: at("2030-01-01T00:00:00Z"), spentTotal: toBase(3000) };
    expect(upcoming(s, "2026-12")).toEqual([]);
    s.rules[0] = { ...s.rules[0], spentTotal: BigInt(0), intervalSecs: 60 };
    expect(upcoming(s, "2026-12")[0]).toMatchObject({ count: 1, firstDue: null });
  });
});

describe("statement from the demo (mock mode)", () => {
  it("shows the funded demo's book allowance with its payee, person and rule", async () => {
    const svc = createMockService({ instant: true });
    svc.resetDemo("funded");
    const thabo = DEMO_PERSONAS.find((p) => p.key === "thabo")!;
    svc.setActor({ address: thabo.address, role: "owner", label: thabo.label });
    const [{ estate }] = await svc.listEstatesFor(thabo.address);
    const snap = await svc.getEstate(estate);
    const s = buildStatement(snap, monthKey(Math.floor(Date.now() / 1000)));
    const books = s.lines.find((l) => l.purpose === "Books");
    expect(books?.amount).toBe(toBase(85));
    expect(snap.payees.find((p) => p.wallet === books?.payee)?.name).toBe("Van Schaik Bookstore");
    expect(snap.beneficiaries.find((b) => b.wallet === books?.person)?.label).toMatch(/^Lerato/);
    expect(s.complete).toBe(true);
  });
});

describe("a reused rule slot", () => {
  it("a scheduled payment before the slot was reused is not read as the new rule's", async () => {
    const { buildStatement, monthKey } = await import("./statement");
    const rule = { address: "R", id: 0, beneficiary: "KID", category: "Medical", allowedPayeeKind: "Other", maxPerClaim: 5n, lifetimeCap: 50n, spentTotal: 0n, validUntil: 9e9, startsNow: true, recurringAmount: 5n, intervalSecs: 60, nextDue: 1, fixedPayee: "P", claimCount: 65_536 } as const;
    const ts = 1_800_000_000;
    const snap = {
      estate: { status: "Active" }, rules: [rule], claims: [], payees: [], beneficiaries: [],
      activity: [
        { ts: ts + 5, kind: "RuleReused", text: "", reusedRule: "R" },
        { ts, kind: "ScheduledPaid", text: "", amount: 5n, payment: { payee: "OLD", rule: "R" } },
      ],
    } as never;
    expect(buildStatement(snap, monthKey(ts)).lines[0].purpose).toBe("Unknown");
  });
});
