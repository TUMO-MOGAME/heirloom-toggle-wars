/** Agent replacement, release, removal with its rules and residual, reused slots, sweeps (plan §18.4 U5). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { getCoder, getIdl } from "../chain/idl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, agentVotePda, ata, beneficiaryPda, estatePda, fallbackReportPda, guardPda, payeePda, residualPda, rulePda,
} from "../chain/pda";
import type { Raw } from "../chain/decoders";
import type { RawSnapshot } from "../chain/reads";
import type { PayeeKind, Rule } from "../types";

const h = vi.hoisted(() => ({ me: "" }));
const programId = new PublicKey(getIdl().address);
const usdtMint = Keypair.generate().publicKey;
vi.mock("../chain/client", () => ({ chainCtx: () => ({ programId, usdtMint }) }));
vi.mock("../wallet/signer", () => ({ getActiveSigner: () => ({ address: h.me }) }));
const { createChainContinuity, rulesOnlyTheyUse } = await import("./chain-continuity");

const k = () => Keypair.generate().publicKey;
const key = () => k().toBase58();
const NOW = 1_800_000_000;
const NOBODY = PublicKey.default.toBase58();
const owner = k();
const estate = estatePda(programId, owner).toBase58();
const [kid, other, landlord, school, secondLandlord] = Array.from({ length: 5 }, key);

const rule = (id: number, over: Partial<Rule> = {}): Rule => ({
  address: rulePda(programId, estate, id).toBase58(), id, beneficiary: other, category: "General", allowedPayeeKind: "School",
  maxPerClaim: 1n, lifetimeCap: 2n, spentTotal: 0n, validUntil: NOW + 9_999, startsNow: true, recurringAmount: 0n,
  intervalSecs: 0, nextDue: null, fixedPayee: null, ...over,
});

let accounts: Map<string, Raw>;
let sent: { ixs: TransactionInstruction[]; opts?: { selfPay?: boolean } }[];
let snap: { estate: { status: string }; beneficiaries: { wallet: string; active: boolean }[]; payees: { wallet: string; kind: PayeeKind }[]; rules: Rule[] };
let ownerNftExists: boolean;
let isOwner: boolean;

beforeEach(() => {
  h.me = owner.toBase58();
  accounts = new Map<string, Raw>([
    [estate, { rule_count: 2, status: { Active: {} } }],
    [residualPda(programId, estate).toBase58(), { recipient: other }],
  ]);
  sent = [];
  ownerNftExists = true;
  isOwner = true;
  snap = {
    estate: { status: "Active" },
    beneficiaries: [{ wallet: kid, active: true }, { wallet: other, active: true }],
    payees: [{ wallet: landlord, kind: "Landlord" }, { wallet: school, kind: "School" }],
    rules: [],
  };
});

const svc = () => createChainContinuity({
  send: async (ixs, opts) => { sent.push({ ixs, opts }); return { signature: `s${sent.length}`, explorerUrl: "" }; },
  requireOwnerOf: () => {
    if (!isOwner) throw new Error("NotOwner: switch to the owner's wallet.");
    return owner;
  },
  fetchRaw: async (_type, address) => accounts.get(address) ?? null,
  fetchEstate: async () => snap as unknown as RawSnapshot,
  accountExists: async () => ownerNftExists,
  now: () => NOW,
});

const all = () => sent.flatMap((s) => s.ixs);
const names = () => all().map((t) => (t.programId.equals(programId) ? getCoder().instruction.decode(Buffer.from(t.data))!.name : "create_ata"));
const args = (i = 0) => getCoder().instruction.decode(Buffer.from(all()[i].data))!.data as Record<string, unknown>;
const has = (i: number, address: PublicKey) => all()[i].keys.some((m) => m.pubkey.equals(address));
const refused = async (work: Promise<unknown>, code: string) => {
  await expect(work).rejects.toMatchObject({ code, message: expect.stringMatching(new RegExp(`^${code}: `)) });
  expect(sent).toHaveLength(0);
};

describe("addRule", () => {
  const input = {
    beneficiary: kid, category: "Books" as const, allowedPayeeKind: "School" as const, maxPerClaimUsdt: 5, lifetimeCapUsdt: 50,
    validUntil: NOW + 999_999, startsNow: true,
  };

  it("a new slot: the next id, with the year cap account", async () => {
    await svc().addRule(estate, input);
    expect(args().rule_id).toBe(2);
    expect(has(0, rulePda(programId, estate, 2))).toBe(true);
  });

  it("an ended rule's slot is reused by its id", async () => {
    const old = rulePda(programId, estate, 0).toBase58();
    accounts.set(old, { estate, id: 0, valid_until: NOW - 1 });
    await svc().addRule(estate, { ...input, reuse: old });
    expect(args().rule_id).toBe(0);
  });

  it("not a live rule's", async () => {
    const live = rulePda(programId, estate, 1).toBase58();
    accounts.set(live, { estate, id: 1, valid_until: NOW + 60 });
    await refused(svc().addRule(estate, { ...input, reuse: live }), "BadStatus");
  });

  it("not another estate's", async () => {
    const theirs = key();
    accounts.set(theirs, { estate: key(), id: 0, valid_until: 1 });
    await refused(svc().addRule(estate, { ...input, reuse: theirs }), "BadStatus");
  });

  it("no seventeenth slot", async () => {
    accounts.set(estate, { rule_count: 16 });
    await refused(svc().addRule(estate, input), "TooManyRules");
  });

  it("a schedule of 0 is refused, never written as a claim rule (U2)", async () => {
    await refused(svc().addRule(estate, { ...input, recurring: { amountUsdt: 0, intervalSecs: 60, firstDue: NOW, payee: school } }), "InvalidAmount");
  });

  it("a schedule keeps its amount and payee", async () => {
    await svc().addRule(estate, { ...input, recurring: { amountUsdt: 4, intervalSecs: 60, firstDue: NOW, payee: school } });
    expect(String(args().recurring_amount)).toBe("4000000");
    expect(has(0, payeePda(programId, estate, school))).toBe(true);
  });
});

describe("sweepResidual", () => {
  it("passes the next recipient's report account and every rule in id order", async () => {
    accounts.delete(residualPda(programId, estate).toBase58());
    accounts.set(guardPda(programId, estate).toBase58(), { fallback: [kid, NOBODY, other, NOBODY], fallback_dead: 1 });
    await svc().sweepResidual(estate);
    const keys = all()[0].keys.map((m) => m.pubkey.toBase58());
    expect(keys).toContain(other);
    expect(keys.slice(-3)).toEqual([
      fallbackReportPda(programId, estate, 2), rulePda(programId, estate, 0), rulePda(programId, estate, 1),
    ].map((x) => x.toBase58()));
  });

  it("a named recipient without a Guard: slot 255", async () => {
    await svc().sweepResidual(estate);
    expect(has(0, fallbackReportPda(programId, estate, 255))).toBe(true);
    expect(await svc().residualOf(estate)).toBe(other);
  });

  it("nobody to pay", async () => {
    accounts.delete(residualPda(programId, estate).toBase58());
    await refused(svc().sweepResidual(estate), "NoResidualRecipient");
  });
  it("P3: after the unlock a removed beneficiary's live rule is ended first, by the caller, then the sweep pays", async () => {
    snap.estate.status = "Unlocked";
    snap.beneficiaries = [{ wallet: kid, active: true }, { wallet: other, active: false }];
    snap.rules = [rule(0, { beneficiary: kid }), rule(1), rule(2, { validUntil: NOW - 1 })];
    await svc().sweepResidual(estate);
    expect(names()).toEqual(["end_orphan_rule", "sweep_residual"]);
    expect(sent).toHaveLength(2);
    expect(has(0, rulePda(programId, estate, 1))).toBe(true);
    expect(has(0, beneficiaryPda(programId, estate, new PublicKey(other)))).toBe(true);
    expect(all()[0].keys[0].pubkey.toBase58()).toBe(owner.toBase58());
  });

  it("P3: nothing to end before the unlock, or when every rule's beneficiary is still in the plan", async () => {
    snap.beneficiaries = [{ wallet: other, active: false }];
    snap.rules = [rule(0)];
    await svc().sweepResidual(estate);
    snap.estate.status = "Unlocked";
    snap.beneficiaries = [{ wallet: other, active: true }];
    await svc().sweepResidual(estate);
    expect(names()).toEqual(["sweep_residual", "sweep_residual"]);
  });
});

describe("the agent", () => {
  it("setAgent: the owner names another wallet", async () => {
    const candidate = key();
    await svc().setAgent(estate, candidate);
    expect(String(args().agent)).toBe(candidate);
  });

  it.each([["nonsense", "not a wallet"], ["the empty key", NOBODY], ["the owner", owner.toBase58()]])("setAgent refuses %s", async (_, candidate) => {
    await refused(svc().setAgent(estate, candidate), "BadAgent");
  });

  it("setAgent is the owner's", async () => {
    isOwner = false;
    await expect(svc().setAgent(estate, key())).rejects.toThrow(/^NotOwner/);
  });

  it("voteAgent: a vote account for the candidate, the voter pays its rent", async () => {
    h.me = key();
    const candidate = key();
    await svc().voteAgent(estate, candidate);
    expect(has(0, agentVotePda(programId, estate, candidate))).toBe(true);
    expect(all()[0].keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(all()[0].keys[0].pubkey.toBase58()).toBe(h.me);
  });

  it("voteAgent passes the voter's Beneficiary PDA always, and after the unlock their own open claim the agent hasn't approved", async () => {
    const tail = () => all()[all().length - 1].keys.slice(-2).map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
    h.me = kid;
    const benPda = beneficiaryPda(programId, estate, kid).toBase58();
    await svc().voteAgent(estate, key());
    expect(tail()[1]).toEqual([benPda, false, false]);
    const [older, newer, other_] = [key(), key(), key()];
    Object.assign(snap, {
      estate: { status: "Unlocked" },
      claims: [
        { address: older, beneficiary: kid, status: "Open", createdAt: 100, agentVerdict: "Referred" }, { address: newer, beneficiary: kid, status: "Open", createdAt: 200, agentVerdict: "Referred" },
        { address: key(), beneficiary: kid, status: "Open", createdAt: 50, agentVerdict: "Approved" },
        { address: other_, beneficiary: other, status: "Open", createdAt: 300 },
      ],
    });
    await svc().voteAgent(estate, key());
    expect(tail()).toEqual([[benPda, false, false], [older, false, false]]); // the earliest unapproved one: its clock ends first
  });

  it("voteAgent refuses a malformed wallet", async () => refused(svc().voteAgent(estate, "x"), "BadAgent"));
});

describe("releaseAsset", () => {
  const [asset, nft] = [key(), k()];
  const held = (status = "Held", of = estate) => accounts.set(asset, { estate: of, nft_mint: nft, status: { [status]: {} } });

  it("creates the owner's title account when it is absent, paid by the owner", async () => {
    held();
    ownerNftExists = false;
    await svc().releaseAsset(estate, asset);
    expect(names()).toEqual(["create_ata", "release_asset"]);
    expect(all()[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(has(0, ata(nft, owner))).toBe(true);
    expect(sent[0].opts?.selfPay).toBe(true);
  });

  it("uses the one that exists, and may be sponsored", async () => {
    held();
    await svc().releaseAsset(estate, asset);
    expect(names()).toEqual(["release_asset"]);
    expect(sent[0].opts?.selfPay).toBe(false);
  });

  it.each(["Listed", "Sold"])("not when %s", async (status) => {
    held(status);
    await refused(svc().releaseAsset(estate, asset), "BadStatus");
  });

  it("not after the passing", async () => {
    held();
    accounts.set(estate, { status: { Unlocked: {} } });
    await refused(svc().releaseAsset(estate, asset), "BadStatus");
  });

  it("not another estate's", async () => {
    held("Held", key());
    await refused(svc().releaseAsset(estate, asset), "BadStatus");
  });
});

describe("removeMember", () => {
  it("a beneficiary: removal first (proof of life), then their live rules end", async () => {
    snap.rules = [rule(0, { beneficiary: kid }), rule(1), rule(2, { beneficiary: kid, validUntil: NOW - 1 })];
    const txs = await svc().removeMember(estate, { beneficiary: kid });
    expect(names()).toEqual(["remove_member", "end_rule"]);
    expect(has(0, beneficiaryPda(programId, estate, kid))).toBe(true);
    expect(has(1, rulePda(programId, estate, 0))).toBe(true);
    expect(txs).toHaveLength(sent.length);
  });

  it("the residual moves before anything else", async () => {
    accounts.set(residualPda(programId, estate).toBase58(), { recipient: kid });
    snap.rules = [rule(0, { beneficiary: kid })];
    await svc().removeMember(estate, { beneficiary: kid, newResidual: other });
    expect(names()).toEqual(["set_residual", "remove_member", "end_rule"]);
    expect(String(args().recipient)).toBe(other);
  });

  it("whoever receives what is left needs a replacement named: code residual", async () => {
    accounts.set(residualPda(programId, estate).toBase58(), { recipient: kid });
    await refused(svc().removeMember(estate, { beneficiary: kid }), "residual");
  });

  it("also when they receive it through the fallback list", async () => {
    accounts.delete(residualPda(programId, estate).toBase58());
    accounts.set(guardPda(programId, estate).toBase58(), { fallback: [kid, NOBODY, NOBODY, NOBODY], fallback_dead: 0 });
    await refused(svc().removeMember(estate, { beneficiary: kid }), "residual");
  });

  it.each([
    ["the same person", () => kid], ["the owner", () => owner.toBase58()], ["the estate", () => estate], ["nobody", () => NOBODY],
    ["someone removed", () => { snap.beneficiaries[1].active = false; return other; }],
  ])("the replacement can't be %s", async (_, next) => {
    await refused(svc().removeMember(estate, { beneficiary: kid, newResidual: next() }), "residual");
  });

  it("a payee: its schedules, and the claim rules only it could serve", async () => {
    snap.rules = [
      rule(0, { allowedPayeeKind: "Landlord", fixedPayee: landlord, recurringAmount: 1n }),
      rule(1, { allowedPayeeKind: "Landlord" }),
      rule(2),
    ];
    await svc().removeMember(estate, { payee: landlord });
    expect(names()).toEqual(["remove_member", "end_rule", "end_rule"]);
    expect(has(0, payeePda(programId, estate, landlord))).toBe(true);
    expect([has(1, rulePda(programId, estate, 0)), has(2, rulePda(programId, estate, 1))]).toEqual([true, true]);
  });

  it("with another payee of the kind, only its schedules end", () => {
    const rules = [rule(0, { allowedPayeeKind: "Landlord", fixedPayee: landlord }), rule(1, { allowedPayeeKind: "Landlord" }), rule(2, { allowedPayeeKind: "Landlord", fixedPayee: secondLandlord })];
    const payees = [{ wallet: landlord, kind: "Landlord" as const }, { wallet: secondLandlord, kind: "Landlord" as const }];
    expect(rulesOnlyTheyUse({ rules, payees }, { payee: landlord }, NOW).map((r) => r.id)).toEqual([0]);
  });

  it("both at once: one remove_member", async () => {
    await svc().removeMember(estate, { beneficiary: kid, payee: landlord });
    expect(names()).toEqual(["remove_member"]);
    expect([has(0, beneficiaryPda(programId, estate, kid)), has(0, payeePda(programId, estate, landlord))]).toEqual([true, true]);
  });

  it("called again after a broken connection: only what is left", async () => {
    snap.beneficiaries[0].active = false;
    snap.rules = [rule(0, { beneficiary: kid })];
    await svc().removeMember(estate, { beneficiary: kid });
    expect(names()).toEqual(["end_rule"]);
  });

  it("many rules: several transactions, the removal in the first", async () => {
    snap.rules = Array.from({ length: 16 }, (_, i) => rule(i, { beneficiary: kid }));
    const txs = await svc().removeMember(estate, { beneficiary: kid });
    expect(txs.length).toBeGreaterThan(1);
    expect(names()).toEqual(["remove_member", ...Array<string>(16).fill("end_rule")]);
  });

  it.each(["DeathPending", "Unlocked"])("nothing is signed while %s", async (status) => {
    snap.estate.status = status;
    await refused(svc().removeMember(estate, { beneficiary: kid }), "BadStatus");
  });

  it("someone who was never in the plan", async () => refused(svc().removeMember(estate, { beneficiary: key() }), "NotBeneficiary"));
  it("nobody named", async () => refused(svc().removeMember(estate, {}), "BadStatus"));
  it("nothing left to do", async () => {
    snap.beneficiaries[0].active = false;
    await refused(svc().removeMember(estate, { beneficiary: kid }), "BadStatus");
  });
});

describe("restoreMember", () => {
  it("adds back a removed family member under a role, never a name", async () => {
    snap.beneficiaries = [{ wallet: kid, active: false, label: "Family member 1" } as never];
    await svc().restoreMember(estate, kid);
    expect(names()).toEqual(["add_beneficiary"]);
    expect(args().label).toBe("Family member 1");
  });
  it("refuses someone still in the plan", async () => {
    await refused(svc().restoreMember(estate, kid), "BadStatus");
  });
});
