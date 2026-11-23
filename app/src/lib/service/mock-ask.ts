/**
 * "Ask for money" in the demo (mock mode): a living claim like any other (the same submit checks in mock.ts), plus the
 * off-chain note (purpose, the owner's decline). Mirrors lib/service/chain-ask.ts.
 */
import type { AgentReport, Base58, Claim } from "../types";
import type { EstateSnapshot, TxResult } from "./types";
import { cleanPurpose, type AskNote, type AskService } from "../ask/types";
import { fail } from "./mock-errors";
import { requireEvidence } from "../evidence";

export interface MockAskDeps {
  snap(): EstateSnapshot;
  /** The persisted notes (created on first use). */
  notes(): Record<Base58, AskNote>;
  me(): Base58;
  /** Short display name for a wallet ("Lerato"). */
  first(wallet: Base58): string;
  payeeName(wallet: Base58): string;
  /** mock.ts submitClaim: every program check, then the claim and its activity lines. */
  submit(input: { rule: Base58; payee: Base58; amountUsdt: number }, evidenceHash: string, report: AgentReport | null, reviewed: string): { t: TxResult; claim: Claim };
  /** True while the scripted agent can't review (MockOptions.agent "down"): the request is sent and waits for it. */
  unreviewed?(): boolean;
  hashFile(f: File): Promise<string>;
  suspicious(f: File): boolean;
  fakeHash(): string;
  zar(usdt: number): string;
  now(): number;
  wait(ms: number): Promise<void>;
  save(): void;
}

/** The scripted reviewer's report for a request: a letter or quote when attached, else the app's own request note. */
export function mockAskReport(input: { purpose: string; amountUsdt: number; zar: string; who: string; payee: string; file: File | null; suspicious: boolean; hash: string }): AgentReport {
  const { purpose, amountUsdt, zar, who, payee, file } = input;
  if (!file) {
    return {
      verdict: "needs_human", documentType: "request_note",
      extracted: { "Asked by": who, "For": purpose, "Amount": `${amountUsdt.toLocaleString("en-ZA")} USD₮ (${zar})`, "Paid to": payee },
      redFlags: [], confidence: 0.9,
      summary: `${who} asks for ${zar} for "${purpose}", paid to ${payee}. No letter or quote was attached, so there is nothing for me to check: you decide. It is within the rule's limits.`,
      reportHash: input.hash,
    };
  }
  if (input.suspicious) {
    return {
      verdict: "reject", documentType: "letter",
      extracted: { "For": purpose, "Amount asked": zar },
      redFlags: ["The amount on the letter appears to have been changed", "The letterhead does not match the sender"],
      confidence: 0.36,
      summary: "This letter looks edited, so I could not accept it and the request was closed. Ask again with a clean copy, or without a letter.",
      reportHash: input.hash,
    };
  }
  return {
    verdict: "approve", documentType: "letter",
    extracted: { "From": payee, "For": purpose, "Amount due": zar, "Learner": who, "Date": new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }) },
    redFlags: [], confidence: 0.91,
    summary: `This is a letter about "${purpose}" in ${who}'s name. It asks for ${zar}, which matches the ${amountUsdt.toLocaleString("en-ZA")} USD₮ requested at today's rate.`,
    reportHash: input.hash,
  };
}

export function createMockAsk(d: MockAskDeps): AskService & { seedAsk(input: { rule: Base58; payee: Base58; amountUsdt: number; purpose: string; typed: number }): Base58 } {
  function record(claim: Base58, input: { purpose: string; currency: AskNote["currency"]; typed: number }, attachment: boolean) {
    d.notes()[claim] = { claim, purpose: cleanPurpose(input.purpose), currency: input.currency, typed: input.typed, createdAt: d.now(), attachment, declinedAt: null };
  }

  function ask(input: { rule: Base58; payee: Base58; amountUsdt: number; purpose: string; currency: AskNote["currency"]; typed: number }, file: File | null, hash: string, seeding = false) {
    const purpose = cleanPurpose(input.purpose);
    if (!purpose) fail("InvalidAmount", "Say what the money is for.");
    const me = d.me();
    const report = mockAskReport({
      purpose, amountUsdt: input.amountUsdt, zar: d.zar(input.amountUsdt), who: d.first(me), payee: d.payeeName(input.payee),
      file, suspicious: file ? d.suspicious(file) : false, hash: d.fakeHash(),
    });
    const reviewed = !file ? `No letter attached: ${d.first(me)}'s request goes to the decision as it is`
      : report.verdict === "reject" ? "The agent could not accept the letter. The request was closed"
        : "The agent checked the letter: it matches the request";
    const down = !seeding && !!d.unreviewed?.();
    const { t, claim } = d.submit({ rule: input.rule, payee: input.payee, amountUsdt: input.amountUsdt }, hash, down ? null : report, reviewed);
    record(claim.address, input, !!file);
    if (down) { d.save(); fail("ReviewPending", "It was sent, but the agent's review didn't finish. Ask for the review again from the request."); }
    return { tx: t, claim: claim.address, report };
  }

  return {
    async askForMoney(_estate, input) {
      const file = input.evidence ? await requireEvidence(input.evidence) : null;
      const hash = file ? await d.hashFile(file) : d.fakeHash();
      await d.wait(file ? 1900 : 900);
      const out = ask(input, file, hash);
      d.save();
      return out;
    },

    async declineAsk(_estate, claimAddr) {
      await d.wait(500);
      const snap = d.snap();
      if (d.me() !== snap.estate.owner) fail("NotOwner", "Only the estate owner can do this.");
      if (snap.estate.status !== "Active") fail("BadStatus", "Only the owner decides, and only while the estate is active.");
      const claim = snap.claims.find((c) => c.address === claimAddr) ?? fail("BadStatus", "That request does not exist.");
      if (claim.status !== "Open" || claim.ownerApproved) fail("BadStatus", "This request is already decided.");
      const notes = d.notes();
      notes[claimAddr] = { ...(notes[claimAddr] ?? { claim: claimAddr, purpose: "", currency: "USDT", typed: 0, createdAt: claim.createdAt, attachment: true }), declinedAt: d.now() };
      d.save();
    },

    /** Demo seeding (synchronous, acting as the asker already). */
    seedAsk(input) {
      return ask({ ...input, currency: "ZAR" }, null, d.fakeHash(), true).claim;
    },
  };
}
