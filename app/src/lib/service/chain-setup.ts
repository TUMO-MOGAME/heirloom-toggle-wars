/**
 * Signing a plan on Solana: everything is decided and checked before the first transaction (U2, R14). A recurring
 * rule is never written as a claim rule: without its payee, signing stops and says what is missing. Pure.
 */
import { PublicKey } from "@solana/web3.js";
import type { Base58, Beneficiary, Category, Payee, PayeeKind, Rule, WillDraft } from "../types";
import { MAX_RULES } from "../continuity/logic";
import { practicePayees } from "../continuity/practice";
import { rulesStillToAdd } from "../continuity/resume";
import { isRoleOnly } from "../chain/public-names";
import { toBase } from "../format";
import { ChainServiceError, must } from "./chain-errors";

type DraftRule = WillDraft["rules"][number];
type Recurrence = NonNullable<DraftRule["recurring"]>["every"];

/** Before anything is signed: three real, different trusted people, an agent who is none of the people, real wallets. */
export function checkPeople(draft: Pick<WillDraft, "beneficiaries" | "verifiers">, owner: Base58, agent: Base58): void {
  const real = (w: Base58 | undefined): boolean => {
    try { return !!w && !new PublicKey(w).equals(PublicKey.default); } catch { return false; }
  };
  const { verifiers, beneficiaries } = draft;
  must(verifiers.length === 3, "DuplicateVerifier", "A plan needs exactly three trusted people.");
  const unnamed = [...verifiers.map((v) => v.name), ...beneficiaries.map((b) => b.label)].filter((n) => !n.trim()).length;
  must(!unnamed, "InvalidWallet", "Give everyone in the plan a name.");
  const noWallet = [...beneficiaries.filter((b) => !real(b.wallet)).map((b) => b.label), ...verifiers.filter((v) => !real(v.wallet)).map((v) => v.name)];
  must(!noWallet.length, "InvalidWallet", `Add real wallet addresses for: ${noWallet.join(", ")}.`);
  must(new Set(verifiers.map((v) => v.wallet)).size === 3, "DuplicateVerifier", "The three trusted people need three different wallets.");
  must(!verifiers.some((v) => v.wallet === owner), "DuplicateVerifier", "You can't be one of your own trusted people.");
  must(new Set(beneficiaries.map((b) => b.wallet)).size === beneficiaries.length, "InvalidWallet", "Two family members have the same wallet.");
  must(new Set(beneficiaries.map((b) => b.label.trim())).size === beneficiaries.length, "InvalidWallet", "Two family members have the same name, so their rules can't be told apart.");
  must(real(agent) && agent !== owner, "BadAgent", "The agent has to be a wallet of its own.");
  const clash = [...verifiers.map((v) => ({ name: v.name, wallet: v.wallet })), ...beneficiaries.map((b) => ({ name: b.label, wallet: b.wallet }))]
    .find((p) => p.wallet === agent);
  must(!clash, "BadAgent", `${clash?.name} has the agent's wallet. Give them one of their own.`);
}

export interface RuleToAdd {
  ruleId: number;
  beneficiary: Base58;
  category: Category;
  allowedPayeeKind: PayeeKind;
  maxPerClaim: bigint;
  lifetimeCap: bigint;
  validUntil: number;
  startsNow: boolean;
  recurring?: { amount: bigint; intervalSecs: number; firstDue: number; payee: Base58 };
}

export interface SetupPlan {
  beneficiaries: WillDraft["beneficiaries"];
  /** Practice mode only. */
  payees: { name: string; kind: PayeeKind; wallet: Base58 }[];
  rules: RuleToAdd[];
}

export interface SetupInput {
  draft: WillDraft;
  /** What is on the chain already (signing again), with the names this device knows. */
  before: { beneficiaries: Beneficiary[]; payees: Payee[]; rules: Rule[] } | null;
  ruleCount: number;
  practice: boolean;
  /** Unix seconds. */
  now: number;
  intervalSecs(every: Recurrence): number;
  newWallet(): Base58;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Signing again: the rules not on the chain yet, and those that are. A schedule only matches the same schedule. */
function splitRules(i: SetupInput): { todo: DraftRule[]; present: Set<Base58> } {
  const left = [...(i.before?.rules ?? [])];
  const present = new Set<Base58>();
  const todo = i.draft.rules.filter((want) => {
    const at = left.findIndex((have) => {
      if (rulesStillToAdd([want], i.draft.beneficiaries, [have]).length) return false;
      const w = want.recurring;
      if (!w) return have.recurringAmount === 0n;
      if (have.recurringAmount !== toBase(w.amountUsdt) || have.intervalSecs !== i.intervalSecs(w.every)) return false;
      const payee = i.before?.payees.find((p) => p.wallet === have.fixedPayee);
      // The ledger holds a role: without the private name, the same amount and interval is the same schedule.
      return !!payee && (sameName(payee.name, w.payeeName) || isRoleOnly(payee.name));
    });
    if (at < 0) return true;
    present.add(left.splice(at, 1)[0].address);
    return false;
  });
  return { todo, present };
}

export function planSetup(i: SetupInput): SetupPlan {
  const { draft, before, now } = i;
  const { todo, present } = splitRules(i);
  const known: { name: string; kind: PayeeKind; wallet: Base58 }[] = [...(before?.payees ?? [])];
  const payees = i.practice
    // A schedule that is already on the chain has its payee already.
    ? practicePayees(draft.rules.map((r) => (todo.includes(r) ? r : { ...r, recurring: undefined })), known)
      .map((p) => ({ ...p, wallet: i.newWallet() }))
    : [];
  known.push(...payees);
  const payeeFor = (r: DraftRule) => known.find((p) => p.kind === r.allowedPayeeKind && sameName(p.name, r.recurring!.payeeName));

  const missing = [...new Set(todo.filter((r) => r.recurring && !payeeFor(r)).map((r) => `"${r.recurring!.payeeName.trim()}" (${r.allowedPayeeKind})`))];
  if (missing.length) {
    throw new ChainServiceError("recurring_payee",
      `A scheduled payment needs an approved payee with a wallet. Missing: ${missing.join(", ")}. Nothing was signed. `
      + "Add them as payees first, or take the schedule out of the plan and add it once they are.");
  }

  // New slots first, then the places of ended rules.
  const slots = Array.from({ length: Math.max(0, MAX_RULES - i.ruleCount) }, (_, n) => i.ruleCount + n);
  for (const r of before?.rules ?? []) if (r.validUntil < now && !present.has(r.address)) slots.push(r.id);
  must(draft.rules.length <= MAX_RULES && todo.length <= slots.length, "TooManyRules", `A plan can have at most ${MAX_RULES} rules.`);

  const rules = todo.map((r, n): RuleToAdd => {
    const person = draft.beneficiaries.find((b) => b.label === r.beneficiaryLabel);
    must(person?.wallet, "NotBeneficiary", `A rule is for "${r.beneficiaryLabel}", who is not in the plan's family.`);
    const [maxPerClaim, lifetimeCap] = [toBase(r.maxPerClaimUsdt), toBase(r.lifetimeCapUsdt)];
    must(maxPerClaim > 0n && lifetimeCap >= maxPerClaim, "InvalidAmount",
      `${r.beneficiaryLabel}'s ${r.category} rule needs limits above zero, with the limit per claim within the total.`);
    const validUntil = Math.floor(Date.parse(r.validUntil) / 1000);
    must(validUntil > now, "TimeOutOfRange", `${r.beneficiaryLabel}'s ${r.category} rule has to end on a date in the future.`);
    let recurring: RuleToAdd["recurring"];
    if (r.recurring) {
      const amount = toBase(r.recurring.amountUsdt);
      // Zero is how the program stores a claim rule, so it would be a downgrade.
      must(amount > 0n, "InvalidAmount", `The scheduled payment to ${r.recurring.payeeName} needs an amount above zero.`);
      must(amount <= maxPerClaim, "ExceedsPerClaimCap", `The scheduled payment to ${r.recurring.payeeName} is more than the rule pays at a time.`);
      const every = i.intervalSecs(r.recurring.every);
      recurring = { amount, intervalSecs: every, firstDue: now + every, payee: payeeFor(r)!.wallet };
    }
    return {
      ruleId: slots[n], beneficiary: person.wallet, category: r.category, allowedPayeeKind: r.allowedPayeeKind,
      maxPerClaim, lifetimeCap, validUntil, startsNow: r.startsNow, recurring,
    };
  });

  const active = new Set((before?.beneficiaries ?? []).filter((b) => b.active).map((b) => b.wallet));
  return { beneficiaries: draft.beneficiaries.filter((b) => !active.has(b.wallet!)), payees, rules };
}
