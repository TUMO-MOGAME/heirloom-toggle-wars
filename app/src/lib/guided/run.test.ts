/** The guided run's steps on the demo's own service and on a chain-shaped one (plan §22.2). */
import { describe, expect, it } from "vitest";
import { createMockService, DEMO_PERSONAS, type MockService } from "../service/mock";
import type { HeirloomService, TxResult, EstateSnapshot } from "../service/types";
import type { Base58, Claim, Rule, WillDraft } from "../types";
import { DEFAULT_PLAN, initialState, isFinished, nextStep, stepOf, type GuidedState } from "./machine";
import { SAMPLE_CHILD, SAMPLE_TRUSTED, runNext, sampleDraft, stepError, type DraftWords, type GuidedDeps } from "./run";

const words: DraftWords = {
  relationship: "daughter", trustedRoles: ["Executor", "Attorney", "Uncle"], notes: "University fees, paid to the university only.",
  summary: "{child}'s university fees: at most {perClaim} USD₮ a claim and {total} in total, until {until}.",
};
const pdf = () => new File(["%PDF-1.4 guided"], "2-uct-fee-statement-lerato.pdf", { type: "application/pdf" });

async function runAll(s: GuidedState, d: GuidedDeps, limit = 30): Promise<GuidedState> {
  for (let i = 0; i < limit && nextStep(s); i++) {
    const before = nextStep(s);
    s = await runNext(s, d);
    if (stepOf(s, before!).status === "failed") return s;
  }
  return s;
}

describe("sampleDraft", () => {
  it("is one child, a university-only rule with both caps, three trusted people and a 30-day wait", () => {
    const d = sampleDraft(DEFAULT_PLAN, { ownerName: "Tumi", child: "C".repeat(32), trusted: ["A".repeat(32), "B".repeat(32), "D".repeat(32)] }, words);
    expect(d.beneficiaries).toEqual([{ label: SAMPLE_CHILD, relationship: "daughter", wallet: "C".repeat(32) }]);
    expect(d.verifiers.map((v) => v.name)).toEqual([...SAMPLE_TRUSTED]);
    expect(d.rules).toHaveLength(1);
    expect(d.rules[0]).toMatchObject({ category: "Tuition", allowedPayeeKind: "University", maxPerClaimUsdt: 50, lifetimeCapUsdt: 200, startsNow: true, beneficiaryLabel: SAMPLE_CHILD });
    expect(d.waitingPeriodDays * 86_400).toBeGreaterThanOrEqual(300);
    expect(d.plainLanguageSummary).toBe("Lerato's university fees: at most 50 USD₮ a claim and 200 in total, until 2029.");
  });
});

describe("stepError", () => {
  it("names the program's refusal, a busy network and the starter's no", () => {
    expect(stepError(new Error("Transaction failed: ExceedsPerClaimCap: more than the rule pays")).code).toBe("ExceedsPerClaimCap");
    expect(stepError(new Error("Server responded with 429 Too Many Requests")).code).toBe("rateLimited");
    expect(stepError(Object.assign(new Error("Try later"), { name: "StarterError", code: "hourly_cap", retryAfterSecs: 120 })))
      .toEqual({ code: "starter", starterCode: "hourly_cap", retryAfterSecs: 120, message: "Try later" });
    expect(stepError(Object.assign(new Error("x"), { code: "NotOwner" })).code).toBe("NotOwner");
    expect(stepError("odd").code).toBe("generic");
  });

  it("reads the program's refusal through the sponsor's failed simulation (seen on devnet, 25 Nov)", () => {
    const e = Object.assign(new Error("Simulation failed: custom program error: ExceedsPerClaimCap"), { code: "simulation_failed" });
    expect(stepError(e).code).toBe("ExceedsPerClaimCap");
  });
});

/* ---------- the demo's service ---------- */

function mockDeps(svc: MockService) {
  const persona = (key: string) => DEMO_PERSONAS.find((p) => p.key === key)!;
  const actorOf = (address: Base58) => {
    const p = DEMO_PERSONAS.find((x) => x.address === address)!;
    return { address: p.address, role: p.role, label: p.label };
  };
  const thabo = persona("thabo");
  const actedAs: Base58[] = [];
  const deps: GuidedDeps = {
    service: svc, now: () => Date.now(), ownerName: "Thabo Mokoena", words,
    async createOwner() { svc.resetDemo("fresh"); svc.setActor(actorOf(thabo.address)); return thabo.address; },
    async createFamily() { return ["lerato", "nomsa", "david", "busi"].map((k) => persona(k).address); },
    as: (address, work) => { actedAs.push(address); return svc.withActor(actorOf(address), work); },
    evidence: async () => pdf(),
    balanceOf: async (a) => svc.balanceOf(a),
  };
  return { deps, thabo, lerato: persona("lerato"), actedAs };
}

describe("guided run on the demo (mock service)", () => {
  it("tells the whole story: signed, funded, claimed, reviewed, approved, paid, then a claim over the cap refused", async () => {
    const svc = createMockService({ instant: true });
    const { deps, thabo, lerato } = mockDeps(svc);
    const s = await runAll(initialState("mock"), deps);
    expect(s.steps.filter((r) => r.status !== "done").map((r) => [r.id, r.error])).toEqual([]);
    expect(isFinished(s)).toBe(true);
    expect(s.owner).toBe(thabo.address);
    expect(s.child).toBe(lerato.address);
    expect(stepOf(s, "money").note).toMatchObject({ simulated: true });
    expect(stepOf(s, "sign").txs.length).toBeGreaterThan(0);
    expect(stepOf(s, "review").note?.verdict).toBe("Approved");
    expect(stepOf(s, "review").txs).toHaveLength(1);
    expect(stepOf(s, "cap").note).toMatchObject({ refused: "ExceedsPerClaimCap", amount: 60 });
    for (const id of ["fund", "claim", "approve", "pay"] as const) expect(stepOf(s, id).txs, id).toHaveLength(1);

    const snap = await svc.getEstate(s.estate!);
    const claim = snap.claims.find((c) => c.address === s.claim)!;
    expect(claim).toMatchObject({ status: "Paid", ownerApproved: true, beneficiary: lerato.address });
    expect(snap.estate.vaultBalance).toBe(BigInt((DEFAULT_PLAN.deposit - DEFAULT_PLAN.claim) * 1_000_000));
    expect(snap.claims).toHaveLength(1); // the refused claim left nothing behind
    expect(snap.estate.deathThreshold).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("signs the child's steps as the child, without changing who the app has signed in", async () => {
    const svc = createMockService({ instant: true });
    const { deps, thabo, lerato } = mockDeps(svc);
    let s = initialState("mock");
    while (nextStep(s) !== "claim") s = await runNext(s, deps);
    // The app's refresh sets the signed-in person (Thabo) while Lerato's claim is being sent: her claim is still hers.
    const as = deps.as;
    deps.as = (address, work) => as(address, async () => { svc.setActor({ address: thabo.address, role: "owner", label: thabo.label }); return work(); });
    s = await runNext(s, deps);
    expect(stepOf(s, "claim").status).toBe("done");
    const snap = await svc.getEstate(s.estate!);
    expect(snap.claims[0].beneficiary).toBe(lerato.address);
    // After it, Thabo acts again: he can approve.
    deps.as = as;
    s = await runAll(s, deps);
    expect(isFinished(s)).toBe(true);
  }, 30_000);

  it("never pays twice when a step is tried again after it went through", async () => {
    const svc = createMockService({ instant: true });
    const { deps } = mockDeps(svc);
    let s = initialState("mock");
    while (nextStep(s) !== "approve") s = await runNext(s, deps);
    // Approve and pay outside the run (as if the first try landed and the tab lost the answer)…
    await svc.withActor({ address: s.owner!, role: "owner", label: "Thabo" }, async () => {
      await svc.ownerApproveClaim(s.estate!, s.claim!);
      await svc.executeClaim(s.estate!, s.claim!);
    });
    s = await runAll(s, deps);
    expect(isFinished(s)).toBe(true);
    expect(stepOf(s, "approve").note).toMatchObject({ already: true });
    expect(stepOf(s, "pay").note).toMatchObject({ already: true });
    expect(stepOf(s, "pay").txs).toHaveLength(0);
    const snap = await svc.getEstate(s.estate!);
    expect(snap.estate.vaultBalance).toBe(BigInt((DEFAULT_PLAN.deposit - DEFAULT_PLAN.claim) * 1_000_000));
  }, 30_000);

  it("stops at a plan that couldn't tell the story", async () => {
    const svc = createMockService({ instant: true });
    const { deps } = mockDeps(svc);
    const s = await runAll({ ...initialState("mock"), plan: { ...DEFAULT_PLAN, claim: 80 } }, deps);
    expect(stepOf(s, "plan")).toMatchObject({ status: "failed", error: { code: "plan" } });
    expect(stepOf(s, "plan").error?.message).toMatch(/claimOverCap/);
  }, 30_000);
});

/* ---------- a chain-shaped service ---------- */

const addr = (n: number) => `${String(n).padStart(3, "0")}${"1".repeat(40)}`;
const explorer = (sig: string): TxResult => ({ signature: sig, explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet` });

/**
 * Just enough of the devnet service: every write is signed by the active wallet, the program's caps and approvals are
 * checked, and faults can be injected (a 429 from the RPC, the starter's no, a review that doesn't finish).
 */
function fakeChain() {
  let n = 0;
  const sig = () => explorer(`sig${++n}`);
  const signedBy: [string, Base58][] = [];
  let active: Base58 | null = null;
  const faults: Partial<Record<string, () => Error>> = {};
  const balances: Record<Base58, bigint> = {};
  let snap: EstateSnapshot | null = null;
  const me = () => { if (!active) throw new Error("No wallet is active."); return active; };
  const write = (what: string) => {
    const f = faults[what];
    if (f) { delete faults[what]; throw f(); }
    signedBy.push([what, me()]);
    return sig();
  };
  const svc = {
    mode: "chain",
    async requestStarter() { const t = write("starter"); balances[me()] = 500_000_000n; return t; },
    async listEstatesFor(w: Base58) { return snap && snap.estate.owner === w ? [{ estate: snap.estate.address, role: "owner", ownerName: "Tumi" }] : []; },
    async unfinishedSigning() { return null; },
    async createEstateFromWill(draft: WillDraft, opts?: { practice?: boolean }) {
      if (!opts?.practice) throw new Error("practice payees expected on devnet");
      const owner = me();
      const txs = [write("create_estate"), write("practice_top_up")];
      const rule: Rule = {
        address: addr(900), id: 0, beneficiary: draft.beneficiaries[0].wallet!, category: "Tuition", allowedPayeeKind: "University",
        maxPerClaim: BigInt(draft.rules[0].maxPerClaimUsdt * 1e6), lifetimeCap: BigInt(draft.rules[0].lifetimeCapUsdt * 1e6), spentTotal: 0n,
        validUntil: 2e9, startsNow: true, recurringAmount: 0n, intervalSecs: 0, nextDue: null, fixedPayee: null, claimCount: 0,
      };
      snap = {
        estate: { address: addr(800), owner, ownerName: draft.ownerName, verifiers: draft.verifiers.map((v) => v.wallet!) as [Base58, Base58, Base58], deathThreshold: 2, vaultBalance: 0n, status: "Active" } as EstateSnapshot["estate"],
        beneficiaries: [{ address: addr(801), wallet: draft.beneficiaries[0].wallet!, label: "Beneficiary 1", active: true }],
        payees: [{ address: addr(802), wallet: addr(803), kind: "University", name: "Practice University" }],
        rules: [rule], claims: [], assets: [], offers: [], hardships: [], activity: [],
      };
      return { estate: snap.estate.address, txs };
    },
    async getEstate() { if (!snap) throw new Error("AccountNotInitialized"); return structuredClone(snap); },
    async deposit(_e: Base58, usdt: number) {
      const t = write("deposit");
      snap!.estate.vaultBalance += BigInt(usdt * 1e6);
      return t;
    },
    async submitClaim(_e: Base58, input: { rule: Base58; payee: Base58; amountUsdt: number }) {
      const rule = snap!.rules[0];
      const amount = BigInt(input.amountUsdt * 1e6);
      if (amount > rule.maxPerClaim) throw new Error("Transaction simulation failed: Error Code: ExceedsPerClaimCap. Error Number: 6012.");
      const tx = write("submit_claim");
      const claim: Claim = {
        address: addr(700 + snap!.claims.length), rule: rule.address, id: 0, beneficiary: me(), payee: input.payee, amount,
        evidenceHash: "00", agentVerdict: "Pending", approvals: [false, false, false], ownerApproved: false, status: "Open", createdAt: 0,
      };
      snap!.claims.unshift(claim);
      if (faults.review) { delete faults.review; throw Object.assign(new Error("ReviewPending: the agent's review didn't finish"), { code: "ReviewPending" }); }
      claim.agentVerdict = "Referred";
      return { tx, claim: claim.address, report: { verdict: "needs_human", summary: "The statement names Lerato." }, reviewTx: explorer("review1") };
    },
    async requestReview(_e: Base58, input: { subject: Base58 }) {
      signedBy.push(["review_request", me()]);
      snap!.claims.find((c) => c.address === input.subject)!.agentVerdict = "Approved";
      return { tx: explorer("review2"), report: { verdict: "approve" } };
    },
    async ownerApproveClaim(_e: Base58, claim: Base58) {
      if (me() !== snap!.estate.owner) throw new Error("NotOwner");
      const t = write("owner_approve");
      snap!.claims.find((c) => c.address === claim)!.ownerApproved = true;
      return t;
    },
    async executeClaim(_e: Base58, claim: Base58) {
      const c = snap!.claims.find((x) => x.address === claim)!;
      if (!c.ownerApproved) throw new Error("InsufficientApprovals");
      const t = write("execute_claim");
      c.status = "Paid";
      snap!.estate.vaultBalance -= c.amount;
      return t;
    },
  };
  const owner = addr(1);
  const family = [addr(2), addr(3), addr(4), addr(5)];
  const deps: GuidedDeps = {
    service: svc as unknown as HeirloomService, now: () => Date.now(), ownerName: "Tumi", words,
    createOwner: async () => owner,
    createFamily: async (people) => { expect(people.map((p) => p.role)).toEqual(["beneficiary", "verifier", "verifier", "verifier"]); return family; },
    async as(address, work) { const prev = active; active = address; try { return await work(); } finally { active = prev; } },
    evidence: async () => pdf(),
    balanceOf: async (a) => balances[a] ?? 0n,
  };
  return { deps, faults, signedBy, owner, child: family[0], snap: () => snap };
}

describe("guided run on devnet (chain-shaped service)", () => {
  it("links every transaction on Explorer, the child signing her own claims and the owner the rest", async () => {
    const c = fakeChain();
    const s = await runAll(initialState("chain"), c.deps);
    expect(isFinished(s)).toBe(true);
    const links = s.steps.flatMap((r) => r.txs);
    expect(links.length).toBeGreaterThanOrEqual(8);
    for (const t of links) expect(t.explorerUrl).toMatch(/^https:\/\/explorer\.solana\.com\/tx\/\w+\?cluster=devnet$/);
    expect(stepOf(s, "review").txs.map((t) => t.signature)).toEqual(["review1"]);
    expect(stepOf(s, "review").note?.verdict).toBe("Referred");
    expect(stepOf(s, "cap").note?.refused).toBe("ExceedsPerClaimCap");
    expect(c.signedBy).toEqual([
      ["starter", c.owner], ["create_estate", c.owner], ["practice_top_up", c.owner], ["deposit", c.owner],
      ["submit_claim", c.child], ["owner_approve", c.owner], ["execute_claim", c.owner],
    ]);
    expect(c.snap()!.estate.vaultBalance).toBe(80_000_000n);
  });

  it("says when the network is busy (429) and finishes on retry without a second deposit", async () => {
    const c = fakeChain();
    let s = initialState("chain");
    while (nextStep(s) !== "fund") s = await runNext(s, c.deps);
    c.faults.deposit = () => new Error("failed to get recent blockhash: 429 Too Many Requests");
    s = await runNext(s, c.deps);
    expect(stepOf(s, "fund")).toMatchObject({ status: "failed", error: { code: "rateLimited" } });
    s = await runNext(s, c.deps);
    expect(stepOf(s, "fund").status).toBe("done");
    // A retry after a deposit that landed finds the vault funded and sends nothing.
    const again = await runNext({ ...s, steps: s.steps.map((r) => (r.id === "fund" ? { ...r, status: "todo" as const, txs: [] } : r)) }, c.deps);
    expect(stepOf(again, "fund").note).toMatchObject({ already: true });
    expect(c.signedBy.filter(([w]) => w === "deposit")).toHaveLength(1);
  });

  it("keeps the starter's reason, and moves on when the money is already there", async () => {
    const c = fakeChain();
    let s = await runNext(initialState("chain"), c.deps);
    c.faults.starter = () => Object.assign(new Error("This hour's test money has been given out."), { name: "StarterError", code: "hourly_cap", retryAfterSecs: 600 });
    s = await runNext(s, c.deps);
    expect(stepOf(s, "money").error).toMatchObject({ code: "starter", starterCode: "hourly_cap", retryAfterSecs: 600 });
    c.faults.starter = () => Object.assign(new Error("already"), { name: "StarterError", code: "already_funded" });
    s = await runNext(s, c.deps);
    expect(stepOf(s, "money")).toMatchObject({ status: "done", note: { had: true } });
  });

  it("asks for the agent's review again when the first one didn't finish", async () => {
    const c = fakeChain();
    c.faults.review = () => new Error("unused");
    const s = await runAll(initialState("chain"), c.deps);
    expect(isFinished(s)).toBe(true);
    expect(stepOf(s, "claim").txs).toHaveLength(0); // the tx went out, the answer was the review's failure
    expect(stepOf(s, "review").txs.map((t) => t.signature)).toEqual(["review2"]);
    expect(stepOf(s, "review").note?.verdict).toBe("Approved");
    expect(c.signedBy).toContainEqual(["review_request", c.child]);
  });

  it("fails the cap step if the program ever accepted a claim over the cap", async () => {
    const c = fakeChain();
    let s = initialState("chain");
    while (nextStep(s) !== "cap") s = await runNext(s, c.deps);
    c.snap()!.rules[0].maxPerClaim = 10_000_000_000n;
    s = await runNext(s, c.deps);
    expect(stepOf(s, "cap")).toMatchObject({ status: "failed", error: { code: "notRefused" } });
  });
});
