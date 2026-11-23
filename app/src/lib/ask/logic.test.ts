/** "Ask for money": payee options, the program's cap checks done early, amounts, who decides, status, and the chat cards. */
import { describe, expect, it } from "vitest";
import { toBase } from "@/lib/format";
import type { EstateSnapshot } from "@/lib/service";
import type { Claim, Rule } from "@/lib/types";
import { DAY, deriveNudges } from "@/lib/chat/derive-nudges";
import { askAf } from "@/content/i18n/ask";
import { amountUsdt, askOptions, askStatus, canAsk, checkAsk, decider, maxAsk, ownerCanDecide, parseAmount, ruleOpen } from "./logic";
import { cleanPurpose, PURPOSE_MAX, type AskNote } from "./types";

const NOW = 1_800_000_000;
const OWNER = "OwnerWallet111111111111111111111111111111111";
const LERATO = "LeratoWallet11111111111111111111111111111111";
const SIPHO = "SiphoWallet111111111111111111111111111111111";
const V = ["Verifier0Wallet111111111111111111111111111111", "Verifier1Wallet111111111111111111111111111111", "Verifier2Wallet111111111111111111111111111111"] as const;
const SHOP = "BookShopWallet1111111111111111111111111111111";
const UCT = "UctWallet1111111111111111111111111111111111";

const everyday = (over: Partial<Rule> = {}): Rule => ({
  address: "RuleEveryday", id: 3, beneficiary: LERATO, category: "General", allowedPayeeKind: "Other",
  maxPerClaim: toBase(60), lifetimeCap: toBase(720), spentTotal: BigInt(0), validUntil: NOW + 365 * DAY,
  startsNow: true, recurringAmount: BigInt(0), intervalSecs: 0, nextDue: null, fixedPayee: null, ...over,
});
const tuition = (over: Partial<Rule> = {}): Rule => everyday({ address: "RuleTuition", id: 1, category: "Tuition", allowedPayeeKind: "University", maxPerClaim: toBase(3500), lifetimeCap: toBase(14000), ...over });
const claim = (over: Partial<Claim> = {}): Claim => ({
  address: "Claim1", rule: "RuleEveryday", id: 0, beneficiary: LERATO, payee: LERATO, amount: toBase(19.44), evidenceHash: "h",
  agentVerdict: "Approved", approvals: [false, false, false], ownerApproved: false, status: "Open", createdAt: NOW - 100, ...over,
});
const note = (over: Partial<AskNote> = {}): AskNote => ({ claim: "Claim1", purpose: "School trip", currency: "ZAR", typed: 350, createdAt: NOW - 100, attachment: false, declinedAt: null, ...over });

function snapshot(over: { estate?: Partial<EstateSnapshot["estate"]> } & Partial<Omit<EstateSnapshot, "estate">> = {}): EstateSnapshot {
  const { estate, ...rest } = over;
  return {
    estate: {
      address: "Estate1", owner: OWNER, ownerName: "Thabo Mokoena", agent: "Agent", usdtMint: "Mint",
      verifiers: [...V], verifierNames: ["A", "B", "C"], deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2,
      waitingPeriodSecs: 60, status: "Active", willHash: null, vaultBalance: toBase(10000), lastHeartbeat: NOW - DAY,
      death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null },
      ...estate,
    },
    beneficiaries: [{ address: "B1", wallet: LERATO, label: "Lerato (daughter)", active: true }],
    payees: [
      { address: "P1", wallet: SHOP, kind: "Other", name: "Van Schaik Bookstore" },
      { address: "P2", wallet: LERATO, kind: "Other", name: "Lerato's own wallet" },
      { address: "P3", wallet: UCT, kind: "University", name: "University of Cape Town" },
    ],
    rules: [everyday(), tuition()], claims: [], assets: [], offers: [], hardships: [], activity: [],
    ...rest,
  };
}

describe("askOptions", () => {
  it("lists every approved payee of the right kind under the asker's open claim rules, everyday and own wallet first", () => {
    const opts = askOptions(snapshot(), LERATO, NOW);
    expect(opts.map((o) => [o.rule.address, o.payee.wallet, o.own])).toEqual([
      ["RuleEveryday", LERATO, true], ["RuleEveryday", SHOP, false], ["RuleTuition", UCT, false],
    ]);
    expect(opts[0].left).toBe(toBase(720));
    expect(opts[0].yearLeft).toBeNull();
  });

  it("leaves out schedules, other people's rules, expired rules, and rules that are not open", () => {
    expect(askOptions(snapshot({ rules: [everyday({ recurringAmount: toBase(85) })] }), LERATO, NOW)).toEqual([]);
    expect(askOptions(snapshot({ rules: [everyday({ beneficiary: SIPHO })] }), LERATO, NOW)).toEqual([]);
    expect(askOptions(snapshot({ rules: [everyday({ validUntil: NOW - 1 })] }), LERATO, NOW)).toEqual([]);
    expect(askOptions(snapshot({ rules: [everyday({ startsNow: false })] }), LERATO, NOW)).toEqual([]);
    expect(askOptions(snapshot({ estate: { status: "DeathPending" } }), LERATO, NOW)).toEqual([]);
    expect(askOptions(snapshot(), null, NOW)).toEqual([]);
    // After unlock every claim rule is open, "starts now" or not.
    expect(askOptions(snapshot({ estate: { status: "Unlocked" }, rules: [everyday({ startsNow: false })] }), LERATO, NOW)).toHaveLength(2);
    expect(canAsk(snapshot(), LERATO, NOW)).toBe(true);
    expect(canAsk(snapshot({ estate: { status: "DeathPending" } }), LERATO, NOW)).toBe(false);
  });

  it("ruleOpen matches the program's rule_open_for", () => {
    expect(ruleOpen({ status: "Active" }, { startsNow: true })).toBe(true);
    expect(ruleOpen({ status: "Active" }, { startsNow: false })).toBe(false);
    expect(ruleOpen({ status: "Unlocked" }, { startsNow: false })).toBe(true);
    expect(ruleOpen({ status: "DeathPending" }, { startsNow: true })).toBe(false);
    expect(ruleOpen({ status: "Frozen" }, { startsNow: true })).toBe(false);
  });
});

describe("checkAsk: the same checks as submit_claim, in order", () => {
  const opt = (r: Partial<Rule> = {}) => askOptions(snapshot({ rules: [everyday(r)] }), LERATO, NOW)[0];

  it("accepts an amount within every cap", () => {
    expect(checkAsk(opt(), toBase(60))).toBeNull();
    expect(maxAsk(opt())).toBe(toBase(60));
  });
  it("refuses zero", () => expect(checkAsk(opt(), BigInt(0))).toEqual({ code: "InvalidAmount" }));
  it("refuses more than the per-claim cap", () => {
    expect(checkAsk(opt(), toBase(60.01))).toEqual({ code: "ExceedsPerClaimCap", limit: toBase(60) });
  });
  it("refuses more than is left under the lifetime cap", () => {
    const o = opt({ spentTotal: toBase(700) });
    expect(checkAsk(o, toBase(30))).toEqual({ code: "ExceedsLifetimeCap", limit: toBase(20) });
    expect(maxAsk(o)).toBe(toBase(20));
  });
  it("refuses more than is left this year under a yearly cap", () => {
    const o = opt({ yearlyCap: { cap: toBase(100), periodStart: NOW - DAY, periodEnd: NOW + 364 * DAY, spent: toBase(90) } });
    expect(o.yearLeft).toBe(toBase(10));
    expect(checkAsk(o, toBase(15))).toEqual({ code: "ExceedsYearlyCap", limit: toBase(10) });
    expect(maxAsk(o)).toBe(toBase(10));
    // A new 12-month period starts the yearly count again.
    const later = askOptions(snapshot({ rules: [everyday({ yearlyCap: { cap: toBase(100), periodStart: NOW - 400 * DAY, periodEnd: NOW - 35 * DAY, spent: toBase(100) } })] }), LERATO, NOW)[0];
    expect(later.yearLeft).toBe(toBase(100));
  });
});

describe("amounts", () => {
  it("converts rand at the current rate, to the cent", () => {
    expect(amountUsdt(350, "ZAR", 18)).toBe(19.44);
    expect(amountUsdt(19.444, "USDT", 18)).toBe(19.44);
    expect(amountUsdt(350, "ZAR", null)).toBeNull();
    expect(amountUsdt(0, "ZAR", 18)).toBe(0);
    expect(amountUsdt(Number.NaN, "USDT", 18)).toBe(0);
  });
  it("reads typed amounts with either decimal mark and thousands separators", () => {
    expect(parseAmount("300")).toBe(300);
    expect(parseAmount("R 1 250")).toBe(1250);
    expect(parseAmount("1,250.50")).toBe(1250.5);
    expect(parseAmount("1 250,5")).toBe(1250.5);
    expect(parseAmount("19.44")).toBe(19.44);
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("abc")).toBeNaN();
  });
  it("keeps a clean, short purpose", () => {
    expect(cleanPurpose("  School\n trip\t ")).toBe("School trip");
    expect(cleanPurpose("x".repeat(200))).toHaveLength(PURPOSE_MAX);
  });
});

describe("who decides and the request's status", () => {
  it("the owner while alive, the trusted people after unlock", () => {
    expect(decider({ status: "Active" }, { startsNow: true })).toBe("owner");
    expect(decider({ status: "Active" }, { startsNow: false })).toBe("later");
    expect(decider({ status: "Unlocked" }, { startsNow: true })).toBe("trusted");
    expect(decider({ status: "DeathPending" }, { startsNow: true })).toBe("paused");
  });

  it("maps the claim and its note to one status", () => {
    const e = { status: "Active" as const, claimThreshold: 1 };
    expect(askStatus(claim({ agentVerdict: "Pending" }), e)).toBe("checking");
    expect(askStatus(claim({ status: "Rejected", agentVerdict: "Rejected" }), e)).toBe("refused");
    expect(askStatus(claim(), e)).toBe("waiting");
    expect(askStatus(claim(), e, note({ declinedAt: NOW }))).toBe("declined");
    expect(askStatus(claim({ ownerApproved: true }), e)).toBe("approved");
    expect(askStatus(claim({ status: "Paid", ownerApproved: true }), e)).toBe("paid");
    // After unlock the trusted people's quorum approves it.
    expect(askStatus(claim({ approvals: [true, false, false] }), { status: "Unlocked", claimThreshold: 1 })).toBe("approved");
    expect(askStatus(claim({ approvals: [true, false, false] }), { status: "Unlocked", claimThreshold: 2 })).toBe("waiting");
  });

  it("the owner can decide an open, cleared request on a living rule that he has not declined", () => {
    const snap = snapshot({ claims: [claim()] });
    expect(ownerCanDecide(snap, claim())).toBe(true);
    expect(ownerCanDecide({ ...snap, asks: { Claim1: note({ declinedAt: NOW }) } }, claim())).toBe(false);
    expect(ownerCanDecide(snapshot({ estate: { status: "Unlocked" } }), claim())).toBe(false);
    expect(ownerCanDecide(snap, claim({ rule: "RuleTuition", payee: UCT }))).toBe(true);
    // A payee the rule no longer allows, or a claimant taken out of the plan: it could never be paid (R16).
    expect(ownerCanDecide(snap, claim({ rule: "RuleTuition" }))).toBe(false);
    expect(ownerCanDecide(snapshot({ beneficiaries: [] }), claim())).toBe(false);
    expect(ownerCanDecide(snapshot({ rules: [everyday({ startsNow: false })] }), claim())).toBe(false);
    expect(ownerCanDecide(snap, claim({ agentVerdict: "Pending" }))).toBe(false);
  });
});

describe("chat home cards for requests", () => {
  const withAsk = (o: { claim?: Partial<Claim>; note?: Partial<AskNote> | null; estate?: Partial<EstateSnapshot["estate"]> } = {}) => snapshot({
    estate: o.estate, claims: [claim(o.claim)], asks: o.note === null ? {} : { Claim1: note(o.note ?? {}) },
  });

  it("the owner gets the request with its purpose, the rand typed, Approve and Decline", () => {
    const n = deriveNudges(withAsk(), "owner", NOW, { usdtZar: 18 }).find((x) => x.kind === "claim-to-approve")!;
    expect(n.title).toBe("Lerato asks for money");
    expect(n.body).toBe("School trip: 19,44 USD₮ · R 350, paid to Lerato's own wallet. No letter attached, so it is your call.");
    expect(n.primary).toMatchObject({ label: "Approve and pay", action: { type: "run", op: "approveAsk", target: "Claim1" } });
    expect(n.secondary).toMatchObject({ label: "Decline", action: { type: "run", op: "declineAsk", target: "Claim1" } });
  });

  it("says the letter checked out when one was attached and the agent approved it", () => {
    const snap = withAsk({ note: { attachment: true, currency: "USDT", typed: 19.44 }, claim: { agentReport: { verdict: "approve", documentType: "letter", extracted: {}, redFlags: [], confidence: 0.9, summary: "", reportHash: "r" } } });
    const n = deriveNudges(snap, "owner", NOW, { usdtZar: 18 }).find((x) => x.kind === "claim-to-approve")!;
    expect(n.body).toBe("School trip: 19,44 USD₮ · R 350, paid to Lerato's own wallet. I checked the letter and it matches.");
  });

  it("a request without a note still shows (a plain claim), and a declined one is gone for the owner and the trusted people", () => {
    const plain = deriveNudges(withAsk({ note: null }), "owner", NOW).find((x) => x.kind === "claim-to-approve")!;
    expect(plain.body).toMatch(/^19,44 USD₮, paid to Lerato's own wallet\./);
    expect(deriveNudges(withAsk({ note: { declinedAt: NOW } }), "owner", NOW).map((x) => x.kind)).not.toContain("claim-to-approve");
    expect(deriveNudges(withAsk({ note: { declinedAt: NOW }, estate: { status: "Unlocked" } }), "verifier", NOW, { address: V[0] }).map((x) => x.kind)).not.toContain("claim-to-approve");
    expect(deriveNudges(withAsk({ estate: { status: "Unlocked" } }), "verifier", NOW, { address: V[0] }).map((x) => x.kind)).toContain("claim-to-approve");
  });

  it("the asker sees where each request stands", () => {
    const card = (o: Parameters<typeof withAsk>[0]) => deriveNudges(withAsk(o), "beneficiary", NOW, { address: LERATO, usdtZar: 18 }).find((x) => x.kind === "ask-update");
    expect(card({})).toMatchObject({ id: "ask:Claim1:waiting", urgency: "info", title: "Your request is with Thabo", body: "School trip: 19,44 USD₮ · R 350. You will see here when it is decided." });
    expect(card({ claim: { status: "Paid", ownerApproved: true } })).toMatchObject({ id: "ask:Claim1:paid", title: "Paid: School trip", body: "19,44 USD₮ · R 350 went to your own wallet." });
    expect(card({ note: { declinedAt: NOW } })).toMatchObject({ id: "ask:Claim1:declined", urgency: "soon", title: "Thabo said no to: School trip", primary: { action: { type: "run", op: "openAsk", target: "RuleEveryday" } } });
    expect(card({ claim: { status: "Rejected", agentVerdict: "Rejected" } })).toMatchObject({ id: "ask:Claim1:refused", title: "Your request could not go ahead" });
    expect(card({ claim: { agentVerdict: "Pending" } })).toBeUndefined();
    // Old requests and other people's requests are not shown.
    expect(card({ claim: { createdAt: NOW - 31 * DAY } })).toBeUndefined();
    expect(card({ claim: { beneficiary: SIPHO } })).toBeUndefined();
  });

  it("after the owner's passing the wording names the trusted people, never the owner", () => {
    const n = deriveNudges(withAsk({ estate: { status: "Unlocked" } }), "beneficiary", NOW, { address: LERATO }).find((x) => x.kind === "ask-update")!;
    expect(n.title).toBe("Your request is with your trusted people");
    expect(n.title + n.body).not.toContain("Thabo");
  });

  it("shows at most three of the asker's requests, newest first", () => {
    const claims = [1, 2, 3, 4].map((i) => claim({ address: `C${i}`, createdAt: NOW - i * 10 }));
    const list = deriveNudges(snapshot({ claims }), "beneficiary", NOW, { address: LERATO }).filter((x) => x.kind === "ask-update");
    expect(list.map((x) => x.id)).toEqual(["ask:C1:waiting", "ask:C2:waiting", "ask:C3:waiting"]);
  });

  it("uses the visitor's language when given", () => {
    const n = deriveNudges(withAsk(), "owner", NOW, { usdtZar: 18, ask: askAf.nudges }).find((x) => x.kind === "claim-to-approve")!;
    expect(n.title).toBe("Lerato vra vir geld");
    expect(n.primary.label).toBe("Keur goed en betaal");
  });
});

describe("H1: one strict reading", () => {
  it("reads a decimal comma as cents and refuses what could mean two things", () => {
    expect(parseAmount("9,50")).toBe(9.5);
    expect(parseAmount("R 1 234,50")).toBe(1234.5);
    expect(parseAmount("1.000")).toBeNaN();
  });
});
