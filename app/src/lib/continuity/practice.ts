/** Practice setup for the test network: who still needs a wallet, and the payees a plan's rules need. Pure. */
import type { PayeeKind, Role, WillDraft } from "../types";
import { fullName } from "../names";

export interface MissingPerson { key: string; name: string; role: Role }

export const personKey = (kind: "b" | "v", index: number) => `${kind}${index}`;

/** People in the plan with no wallet yet. `wallets` holds what the owner pasted or made, by key. */
export function missingPeople(draft: Pick<WillDraft, "beneficiaries" | "verifiers">, wallets: Record<string, string> = {}): MissingPerson[] {
  const out: MissingPerson[] = [];
  draft.beneficiaries.forEach((b, i) => {
    if (!b.wallet && !wallets[personKey("b", i)]) out.push({ key: personKey("b", i), name: b.label, role: "beneficiary" });
  });
  draft.verifiers.forEach((v, i) => {
    if (!v.wallet && !wallets[personKey("v", i)]) out.push({ key: personKey("v", i), name: v.name, role: "verifier" });
  });
  return out;
}

/** The draft with those wallets filled in: what is hashed and signed. */
export function withWallets(draft: WillDraft, wallets: Record<string, string>): WillDraft {
  return {
    ...draft,
    beneficiaries: draft.beneficiaries.map((b, i) => (!b.wallet && wallets[personKey("b", i)] ? { ...b, wallet: wallets[personKey("b", i)] } : b)),
    verifiers: draft.verifiers.map((v, i) => (!v.wallet && wallets[personKey("v", i)] ? { ...v, wallet: wallets[personKey("v", i)] } : v)),
  };
}

const PRACTICE_NAME: Record<PayeeKind, string> = {
  University: "Practice University",
  School: "Practice School",
  Landlord: "Practice Landlord",
  Other: "Practice Payee",
};

/**
 * The payees to create: each scheduled payee by the name the rule gives, and one per kind that no payee covers.
 * A name that is already an approved payee of that kind is left alone.
 */
export function practicePayees(rules: WillDraft["rules"], existing: { name: string; kind: PayeeKind }[] = []): { name: string; kind: PayeeKind }[] {
  const out: { name: string; kind: PayeeKind }[] = [];
  const all = () => [...existing, ...out];
  for (const r of rules) {
    if (!r.recurring) continue;
    const name = r.recurring.payeeName.trim().slice(0, 64);
    if (name && !all().some((p) => p.kind === r.allowedPayeeKind && p.name.toLowerCase() === name.toLowerCase())) {
      out.push({ name, kind: r.allowedPayeeKind });
    }
  }
  for (const r of rules) {
    if (!all().some((p) => p.kind === r.allowedPayeeKind)) out.push({ name: PRACTICE_NAME[r.allowedPayeeKind], kind: r.allowedPayeeKind });
  }
  return out;
}

/** Scheduled payments with no approved payee of that name and kind: signing stops on them, it never downgrades them (U2). */
export function missingPayees(
  rules: WillDraft["rules"], existing: readonly { name: string; kind: PayeeKind }[] = [], practice = false,
): { index: number; name: string; kind: PayeeKind }[] {
  const known = practice ? [...existing, ...practicePayees(rules, [...existing])] : existing;
  return rules.flatMap((r, index) => {
    if (!r.recurring) return [];
    const name = r.recurring.payeeName.trim();
    const found = !!name && known.some((p) => p.kind === r.allowedPayeeKind && p.name.toLowerCase() === name.toLowerCase());
    return found ? [] : [{ index, name, kind: r.allowedPayeeKind }];
  });
}

/** The owner's explicit choice, shown before signing: a schedule becomes a rule paid on request. */
export const paidOnRequest = (rule: WillDraft["rules"][number]): WillDraft["rules"][number] => {
  const { recurring, ...rest } = rule;
  void recurring;
  return rest;
};

export type TrustedProblem = "three" | "name" | "wallet" | "samePerson" | "sameWallet" | "owner";

/** Setup takes three different real trusted people (R14). `heirs`: the ones who are also in the family. */
export function checkTrusted(
  draft: Pick<WillDraft, "ownerName" | "beneficiaries" | "verifiers">, ownerWallet?: string | null,
): { problem: TrustedProblem | null; heirs: string[] } {
  const norm = (s: string) => fullName(s).trim().replace(/\s+/g, " ").toLowerCase();
  const people = draft.verifiers;
  const heirs = people
    .filter((v) => draft.beneficiaries.some((b) => (!!v.wallet && v.wallet === b.wallet) || norm(v.name) === norm(b.label)))
    .map((v) => v.name);
  const wallets = people.flatMap((v) => (v.wallet ? [v.wallet] : []));
  const problem: TrustedProblem | null = people.length !== 3 ? "three"
    : people.some((v) => !norm(v.name)) ? "name"
      : wallets.some((w) => /^1{32}$/.test(w)) ? "wallet"
        : (!!ownerWallet && wallets.includes(ownerWallet)) || people.some((v) => norm(v.name) === norm(draft.ownerName)) ? "owner"
          : new Set(wallets).size !== wallets.length ? "sameWallet"
            : new Set(people.map((v) => norm(v.name))).size !== 3 ? "samePerson" : null;
  return { problem, heirs };
}
