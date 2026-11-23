/**
 * Plan §18.3 S2: what a newcomer's plan really costs in SOL, from the code, and that the grant covers it with room.
 *
 * The reference newcomer signs the app's own example will (DEMO_WILL: three children, three trusted people, four
 * rules) with practice wallets and practice payees, then sets up the guard and its three seats, a yearly cap and one
 * asset with a fresh title. Account sizes come from the IDL, so a program change shows here. Network fees are the
 * sponsor's; they are counted anyway, in case it is down.
 *
 * Devnet rent on 22 Nov 2026: getMinimumBalanceForRentExemption(0) = 650,240 = 128 × 5,080 lamports a byte.
 *
 *   setup  35.8 M + practice top-ups 6 × 6 M + fees = about 72 M. The grant is 80 M (it was 90 M).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getIdl, norm } from "../chain/idl";
import { DEMO_WILL } from "../agent/canned";
import { practicePayees } from "../continuity/practice";

vi.mock("server-only", () => ({}));
const { STARTER, starterLamports } = await import("./server");

const LAMPORTS_PER_BYTE = 5_080;
const rent = (bytes: number, perByte = LAMPORTS_PER_BYTE) => (bytes + 128) * perByte;

/** INIT_SPACE's longest strings (programs/heirloom/src/state.rs, #[max_len]). */
const MAX_STRING: Record<string, number> = { will_uri: 200, label: 32, name: 64 };
const FIXED: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, u32: 4, u64: 8, i64: 8, pubkey: 32 };

function typeBytes(type: unknown, field: string): number {
  if (typeof type === "string") {
    if (type === "string" && field in MAX_STRING) return 4 + MAX_STRING[field];
    if (type in FIXED) return FIXED[type];
  } else if (type && typeof type === "object") {
    const t = type as { array?: [unknown, number]; option?: unknown; defined?: { name: string } };
    if (t.array) return typeBytes(t.array[0], field) * t.array[1];
    if (t.option !== undefined) return 1 + typeBytes(t.option, field);
    if (t.defined) return structBytes(t.defined.name);
  }
  throw new Error(`no size for ${field}: ${JSON.stringify(type)}`);
}

function structBytes(name: string): number {
  const def = getIdl().types!.find((t) => norm(t.name) === norm(name))!.type;
  if (def.kind === "enum") return 1;
  if (def.kind !== "struct") throw new Error(`no size for ${name}`);
  return (def.fields as { name: string; type: unknown }[]).reduce((sum, f) => sum + typeBytes(f.type, f.name), 0);
}

const account = (name: string) => 8 + structBytes(name);
const MINT = 82, TOKEN = 165;

const payees = practicePayees(DEMO_WILL.rules).length;
const people = DEMO_WILL.beneficiaries.length + DEMO_WILL.verifiers.length;

/** [what, how many, bytes of each]: every account the owner pays rent for. */
const SIGNING: [string, number, number][] = [
  ["estate", 1, account("Estate")],
  ["vault", 1, TOKEN],
  ["beneficiaries", DEMO_WILL.beneficiaries.length, account("Beneficiary")],
  ["payees", payees, account("Payee")],
  ["rules", DEMO_WILL.rules.length, account("Rule")],
  ["residual", 1, account("Residual")],
];
const AFTERWARDS: [string, number, number][] = [
  ["guard", 1, account("Guard")],
  ["seats", 3, account("Seat")],
  ["yearly cap", 1, account("YearCap")],
  ["asset", 1, account("Asset")],
  ["asset photos", 1, account("AssetMedia")],
  ["title mint", 1, MINT],
  ["owner's title account", 1, TOKEN],
  ["title escrow", 1, TOKEN],
];
const cost = (rows: [string, number, number][], perByte = LAMPORTS_PER_BYTE) => rows.reduce((sum, [, n, b]) => sum + n * rent(b, perByte), 0);

/** chain.ts's top-up for each practice wallet. */
const PRACTICE = Number(
  /const PRACTICE_SOL_LAMPORTS = ([\d_]+);/.exec(readFileSync(path.resolve(process.cwd(), "src/lib/service/chain.ts"), "utf8"))![1].replaceAll("_", ""),
);
/** At most twenty transactions, two signatures each, if the sponsor is down. */
const FEES = 20 * 2 * 5_000;
/** The owner's wallet must itself stay rent-exempt. */
const WALLET_MINIMUM = rent(0);

const NEED = cost(SIGNING) + cost(AFTERWARDS) + people * PRACTICE + FEES + WALLET_MINIMUM;

describe("what a newcomer's plan costs", () => {
  it("is the sum the starter was sized from", () => {
    expect([DEMO_WILL.beneficiaries.length, payees, DEMO_WILL.rules.length, people]).toEqual([3, 3, 4, 6]);
    expect(rent(0)).toBe(650_240);
    expect([account("Estate"), account("Beneficiary"), account("Payee"), account("Rule"), account("Seat"), account("Guard")])
      .toEqual([533, 110, 142, 170, 310, 205]);
    // 3,357,880 estate + 1,488,440 vault + 3 × 1,209,040 + 3 × 1,371,600 + 4 × 1,513,840 + 1,021,080 residual
    expect(cost(SIGNING)).toBe(19_664_680);
    // 1,691,640 guard + 3 × 2,225,040 seats + 980,440 + 1,681,480 + 1,071,880 + 1,066,800 + 2 × 1,488,440
    expect(cost(AFTERWARDS)).toBe(16_144_240);
    expect(NEED).toBe(19_664_680 + 16_144_240 + 36_000_000 + 200_000 + 650_240);
  });

  it("fits the grant, with room for one more child, payee and rule", () => {
    const oneMore = rent(account("Beneficiary")) + rent(account("Payee")) + rent(account("Rule"));
    expect(STARTER.lamports - NEED).toBeGreaterThanOrEqual(oneMore);
    expect((STARTER.lamports - NEED) / STARTER.lamports).toBeGreaterThan(0.05);
  });

  it("is smaller than the 90,000,000 it was, and not padded", () => {
    expect(STARTER.lamports).toBeLessThan(90_000_000);
    expect(STARTER.lamports).toBeLessThan(NEED * 1.15);
  });

  it("leaves enough right after signing for chain.ts to top up every practice wallet", () => {
    expect(STARTER.lamports - cost(SIGNING) - FEES).toBeGreaterThan(PRACTICE * (people + 1));
  });

  it("a practice wallet's top-up covers a claim, a dispute and staying rent-exempt", () => {
    expect(PRACTICE).toBeGreaterThanOrEqual(rent(account("Claim")) + rent(account("Objection")) + rent(0));
  });

  it("the setup still fits if devnet goes back to mainnet's old 6,960 a byte", () => {
    expect(cost(SIGNING, 6_960) + cost(AFTERWARDS, 6_960) + FEES).toBeLessThan(STARTER.lamports);
  });

  it("covers the agent's side: the wallet's USD₮ account and the fee", () => {
    expect(STARTER.accountLamports).toBeGreaterThanOrEqual(rent(TOKEN) + 5_000);
  });

  it("a wallet that has faucet SOL gets only the USD₮", () => {
    expect(starterLamports(0)).toBe(STARTER.lamports);
    expect(starterLamports(STARTER.hasSolLamports)).toBe(0);
  });
});
