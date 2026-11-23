/** Chain read side of disputes and yearly caps: real IDL encoding → the snapshot shapes the UI uses. */
import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getCoder } from "./idl";
import type { Raw } from "./decoders";
import { assembleDisputes, decodeYearCap, isDisputeRaw } from "./disputes";
import { disputesVotedBy, effectiveStatus, YEAR_SECS } from "../disputes/types";
import type { Estate, Rule } from "../types";

const k = () => Keypair.generate().publicKey;
const estateKey = k(), claim = k(), kid = k(), ruleKey = k();
const v = [k(), k(), k()];
const roundTrip = async (type: string, raw: Record<string, unknown>) => getCoder().accounts.decode(type, await getCoder().accounts.encode(type, raw)) as Raw;

const objection = (over: Record<string, unknown> = {}) => ({
  estate: estateKey, target: claim, kind: { Claim: {} }, monitor: kid, seat_index: 254, reason_hash: Array(32).fill(0xab),
  raised_at: new BN(1_000), status: { Open: {} }, votes_uphold: 0b001, votes_dismiss: 0b100, bump: 255, ...over,
});

const estate = {
  address: estateKey.toBase58(), verifiers: v.map((x) => x.toBase58()), verifierNames: ["Adv. Ndlovu", "Ms. Pillay", "Uncle Bongani"], waitingPeriodSecs: 120,
} as unknown as Estate;
const rule = { address: ruleKey.toBase58() } as Rule;

describe("disputes from Objection accounts", () => {
  it("decodes a dispute (seat_index 254) with votes, lapse time and the reason known on this device", async () => {
    const raw = await roundTrip("Objection", objection());
    expect(isDisputeRaw(raw)).toBe(true);
    const out = assembleDisputes({ disputes: [{ address: "D1", raw }], yearCaps: {} }, {
      estate, rules: [rule], names: { [kid.toBase58()]: "Sipho" }, reasons: { ["ab".repeat(32)]: "Already paid." },
    });
    expect(out.disputes[0]).toMatchObject({
      address: "D1", kind: "Claim", target: claim.toBase58(), disputerName: "Sipho", reason: "Already paid.", status: "Open",
      raisedAt: 1_000, lapsesAt: 1_120, votesUphold: 1, votesDismiss: 1, voted: [0, 2],
    });
    expect(effectiveStatus(out.disputes[0], 1_119)).toBe("Open");
    expect(effectiveStatus(out.disputes[0], 1_120)).toBe("Lapsed");
    // Inbox → Handled on devnet: the voters (trusted people 0 and 2) see it, the one who didn't vote (1) doesn't.
    expect(disputesVotedBy(out.disputes, 0).map((d) => d.address)).toEqual(["D1"]);
    expect(disputesVotedBy(out.disputes, 2).map((d) => d.address)).toEqual(["D1"]);
    expect(disputesVotedBy(out.disputes, 1)).toEqual([]);
  });

  it("a monitor's objection is not a dispute; a verifier disputer gets their trusted-person name", async () => {
    expect(isDisputeRaw(await roundTrip("Objection", objection({ seat_index: 2 })))).toBe(false);
    const raw = await roundTrip("Objection", objection({ monitor: v[1], kind: { Unlock: {} }, target: estateKey }));
    const d = assembleDisputes({ disputes: [{ address: "D2", raw }], yearCaps: {} }, { estate, rules: [], names: {}, reasons: {} }).disputes[0];
    expect(d).toMatchObject({ kind: "Unlock", disputerName: "Ms. Pillay", reason: "" });
  });
});

describe("yearly caps from YearCap accounts", () => {
  it("attaches the cap to its rule", async () => {
    const raw = await roundTrip("YearCap", { rule: ruleKey, cap: new BN(3_000_000_000), period_start: new BN(5_000), period_spent: new BN(1_500_000_000), bump: 254 });
    expect(decodeYearCap(raw)).toEqual({ cap: 3_000_000_000n, periodStart: 5_000, periodEnd: 5_000 + YEAR_SECS, spent: 1_500_000_000n });
    const other = { address: new PublicKey(k()).toBase58() } as Rule;
    const { rules } = assembleDisputes({ disputes: [], yearCaps: { [ruleKey.toBase58()]: raw } }, { estate, rules: [rule, other], names: {}, reasons: {} });
    expect(rules[0].yearlyCap?.cap).toBe(3_000_000_000n);
    expect(rules[1].yearlyCap).toBeUndefined();
  });
});
