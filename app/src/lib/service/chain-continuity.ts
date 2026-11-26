/**
 * ContinuityService on Solana, and adding a rule (which can reuse an ended rule's slot): docs/program-spec.md
 * "Second security review". Owner writes check the chain first, so nothing is signed that can't work.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import type { Base58, PayeeKind, Rule } from "../types";
import type { ContinuityService, RemoveMemberInput } from "../continuity/types";
import type { HeirloomService, TxResult } from "./types";
import { MAX_RULES, orphanRules } from "../continuity/logic";
import { toBase } from "../format";
import { chainCtx } from "../chain/client";
import * as ix from "../chain/instructions";
import { ata, guardPda, residualPda, rulePda } from "../chain/pda";
import { enumOf, key, num, type Raw } from "../chain/decoders";
import { nextFallback } from "../chain/guardians";
import { pack } from "../chain/pack";
import type { RawSnapshot } from "../chain/reads";
import { getActiveSigner } from "../wallet/signer";
import { isRoleOnly, publicBeneficiaryLabel } from "../chain/public-names";
import { ChainServiceError, must } from "./chain-errors";
import { ownOpenClaim } from "../guardians/decisions";

export interface ChainContinuityDeps {
  send(ixs: TransactionInstruction[], opts?: { selfPay?: boolean }): Promise<TxResult>;
  requireOwnerOf(estate: Base58): PublicKey;
  fetchRaw(type: string, address: Base58): Promise<Raw | null>;
  /** The estate read afresh, never from the shared scan of a few seconds ago. */
  fetchEstate(estate: Base58): Promise<RawSnapshot>;
  accountExists(address: PublicKey): Promise<boolean>;
  /** Unix seconds. */
  now?(): number;
}

type ChainContinuity = Omit<ContinuityService, "requestStarter"> & Pick<HeirloomService, "addRule"> & {
  /** Who a sweep would pay. */
  residualOf(estate: Base58): Promise<Base58 | null>;
};

const STATUS = ["Active", "DeathPending", "Unlocked", "Frozen"] as const;
/** Chain and device clocks differ a little: a rule this close to its end is left to end by itself. */
const ENDING_SECS = 30;

/** A wallet someone typed or picked. */
export function walletKey(address: Base58, code = "InvalidAddress"): PublicKey {
  let parsed: PublicKey | null = null;
  try { parsed = new PublicKey(address.trim()); } catch { /* refused below */ }
  must(parsed && !parsed.equals(PublicKey.default), code, "That is not a wallet address.");
  return parsed;
}

/**
 * The live rules that only the removed member could use: the beneficiary's own, the payee's schedules, and, when the
 * payee was the last of its kind, the claim rules that can pay only that kind.
 */
export function rulesOnlyTheyUse(
  snap: { rules: Rule[]; payees: { wallet: Base58; kind: PayeeKind }[] },
  removed: Pick<RemoveMemberInput, "beneficiary" | "payee">,
  now: number,
): Rule[] {
  const payee = removed.payee ? snap.payees.find((p) => p.wallet === removed.payee) : undefined;
  const lastOfKind = payee && !snap.payees.some((p) => p.wallet !== payee.wallet && p.kind === payee.kind) ? payee.kind : null;
  return snap.rules.filter((r) => {
    if (r.validUntil <= now + ENDING_SECS) return false;
    if (removed.beneficiary && r.beneficiary === removed.beneficiary) return true;
    if (!removed.payee) return false;
    return r.fixedPayee ? r.fixedPayee === removed.payee : !!lastOfKind && r.allowedPayeeKind === lastOfKind;
  });
}

export function createChainContinuity(d: ChainContinuityDeps): ChainContinuity {
  const now = () => d.now?.() ?? Math.floor(Date.now() / 1000);
  const me = () => new PublicKey(getActiveSigner().address);

  async function estateRaw(estate: Base58): Promise<Raw> {
    const raw = await d.fetchRaw("Estate", estate);
    must(raw, "NoEstate", "That estate was not found on-chain.");
    return raw;
  }

  /** The named recipient, else the next on the fallback list; and the slot whose death report can hold a sweep. */
  async function sweepTarget(estate: Base58): Promise<{ recipient: Base58 | null; reportIndex: number }> {
    const { programId } = chainCtx();
    const [named, guard] = await Promise.all([
      d.fetchRaw("Residual", residualPda(programId, estate).toBase58()),
      d.fetchRaw("Guard", guardPda(programId, estate).toBase58()),
    ]);
    const next = nextFallback(guard);
    return { recipient: named ? key(named, "recipient") : next.wallet, reportIndex: next.index };
  }

  return {
    residualOf: async (estate) => (await sweepTarget(estate)).recipient,

    async addRule(estate, input) {
      const owner = d.requireOwnerOf(estate);
      const beneficiary = walletKey(input.beneficiary);
      let ruleId: number;
      if (input.reuse) {
        const old = await d.fetchRaw("Rule", input.reuse);
        must(old && key(old, "estate") === estate, "BadStatus", "That rule is not in this plan.");
        must(now() > num(old, "valid_until"), "BadStatus", "Only a rule that has ended gives up its place. End it first.");
        ruleId = num(old, "id");
      } else {
        ruleId = num(await estateRaw(estate), "rule_count");
        must(ruleId < MAX_RULES, "TooManyRules", `A plan can have at most ${MAX_RULES} rules. Use an ended rule's place.`);
      }
      const r = input.recurring;
      const amount = r ? toBase(r.amountUsdt) : 0n;
      // An amount of 0 would store a claim rule: never downgrade a schedule (U2).
      must(!r || amount > 0n, "InvalidAmount", "A scheduled payment needs an amount above zero.");
      return d.send([ix.addRule(chainCtx(), owner, {
        ruleId, beneficiaryWallet: beneficiary, category: input.category, allowedPayeeKind: input.allowedPayeeKind,
        maxPerClaim: toBase(input.maxPerClaimUsdt), lifetimeCap: toBase(input.lifetimeCapUsdt), validUntil: input.validUntil,
        startsNow: input.startsNow,
        recurring: r && { amount, intervalSecs: r.intervalSecs, firstDue: r.firstDue, payeeWallet: walletKey(r.payee) },
      })]);
    },

    async endRule(estate, rule) {
      return d.send([ix.endRule(chainCtx(), d.requireOwnerOf(estate), new PublicKey(rule))]);
    },

    async setResidual(estate, recipient) {
      return d.send([ix.setResidual(chainCtx(), d.requireOwnerOf(estate), walletKey(recipient))]);
    },

    async sweepResidual(estate) {
      const { recipient, reportIndex } = await sweepTarget(estate);
      must(recipient, "NoResidualRecipient", "The owner did not name anyone to receive what is left.");
      const ctx = chainCtx();
      const count = num(await estateRaw(estate), "rule_count");
      const snap = await d.fetchEstate(estate);
      const rules = Array.from({ length: count }, (_, i) => rulePda(ctx.programId, estate, i));
      // A removed beneficiary's live rule is ended first (P3), so its reserve is paid too. Anyone may; no money moves.
      const orphans = snap.estate.status === "Unlocked" && ix.hasInstruction("end_orphan_rule") ? orphanRules(snap.rules, snap.beneficiaries, now() + ENDING_SECS) : [];
      const ends = orphans.map((r) => ix.endOrphanRule(ctx, { caller: me(), estate: new PublicKey(estate), rule: new PublicKey(r.address), beneficiaryWallet: new PublicKey(r.beneficiary) }));
      for (const group of pack(ends)) await d.send(group);
      return d.send([ix.sweepResidual(ctx, { payer: me(), estate: new PublicKey(estate), recipient: new PublicKey(recipient), reportIndex, rules })]);
    },

    async setAgent(estate, agent) {
      const owner = d.requireOwnerOf(estate);
      const candidate = walletKey(agent, "BadAgent");
      must(!candidate.equals(owner), "BadAgent", "You can't be your own agent.");
      return d.send([ix.setAgent(chainCtx(), owner, candidate)]);
    },

    async voteAgent(estate, candidate) {
      const who = walletKey(candidate, "BadAgent");
      const voter = me();
      // After the unlock the program reads the voter's own open claim (the lone voter who gains waits 2 RT from it).
      const snap = await d.fetchEstate(estate);
      const claim = snap.estate.status === "Unlocked" ? ownOpenClaim(snap.claims, voter.toBase58()) : null;
      return d.send([ix.voteAgent(chainCtx(), new PublicKey(estate), voter, who, claim ? new PublicKey(claim.address) : null)]);
    },

    async releaseAsset(estate, asset) {
      const owner = d.requireOwnerOf(estate);
      const raw = await d.fetchRaw("Asset", asset);
      must(raw && key(raw, "estate") === estate, "BadStatus", "That asset is not in this plan.");
      must(enumOf(raw, "status", ["Held", "Listed", "Sold"] as const) === "Held", "BadStatus", "Only an asset the plan still holds can come back.");
      must(enumOf(await estateRaw(estate), "status", STATUS) === "Active", "BadStatus", "Only a living owner, with the plan active, takes an asset back.");
      const mint = new PublicKey(key(raw, "nft_mint"));
      const ownerNft = ata(mint, owner);
      const create = !(await d.accountExists(ownerNft));
      return d.send([
        ...(create ? [createAssociatedTokenAccountIdempotentInstruction(owner, ownerNft, owner, mint)] : []),
        ix.releaseAsset(chainCtx(), owner, new PublicKey(asset), mint),
      ], { selfPay: create }); // the sponsor only creates USD₮ accounts
    },

    async restoreMember(estate, wallet) {
      const owner = d.requireOwnerOf(estate);
      const snap = await d.fetchEstate(estate);
      must(snap.estate.status === "Active", "BadStatus", "Only while the plan is active.");
      const at = snap.beneficiaries.findIndex((b) => b.wallet === wallet);
      must(at >= 0 && !snap.beneficiaries[at].active, "BadStatus", "They aren't someone who was removed from this plan.");
      // The label stays a role, never a name (POPIA, chain/public-names.ts).
      const label = isRoleOnly(snap.beneficiaries[at].label) ? snap.beneficiaries[at].label : publicBeneficiaryLabel(at);
      return d.send([ix.addBeneficiary(chainCtx(), owner, walletKey(wallet), label)]);
    },

    /**
     * In this order: name the new residual recipient, remove (proof of life: it clears any death claim, so the plan
     * can't leave Active under what follows), end the rules. Each needs the estate Active. Safe to call again after a
     * broken connection: what is done is skipped.
     */
    async removeMember(estate, input) {
      const owner = d.requireOwnerOf(estate);
      const { beneficiary, payee, newResidual } = input;
      must(beneficiary || payee, "BadStatus", "Choose who to remove.");
      const snap = await d.fetchEstate(estate);
      must(snap.estate.status === "Active", "BadStatus",
        "The plan must be active to remove someone. If a passing is being confirmed, say you are still here first.");

      const person = beneficiary ? snap.beneficiaries.find((b) => b.wallet === beneficiary) : undefined;
      must(!beneficiary || person, "NotBeneficiary", "That wallet is not a family member in this plan.");
      const removePerson = !!person?.active;
      const removePayee = !!payee && snap.payees.some((p) => p.wallet === payee);

      const ctx = chainCtx();
      const todo: TransactionInstruction[] = [];
      if (beneficiary) {
        const inherits = (await sweepTarget(estate)).recipient === beneficiary;
        if (inherits && !newResidual) {
          throw new ChainServiceError("residual", "They receive what is left of the plan. Choose who receives it instead.");
        }
        if (newResidual) {
          const next = walletKey(newResidual, "residual");
          const gone = snap.beneficiaries.some((b) => b.wallet === newResidual && !b.active);
          must(newResidual !== beneficiary && newResidual !== estate && !next.equals(owner) && !gone, "residual",
            "Choose someone else to receive what is left: not you, the plan itself, or someone who was removed.");
          todo.push(ix.setResidual(ctx, owner, next));
        }
      }
      if (removePerson || removePayee) {
        todo.push(ix.removeMember(ctx, owner, {
          ...(removePerson ? { beneficiary: new PublicKey(beneficiary!) } : {}),
          ...(removePayee ? { payee: new PublicKey(payee!) } : {}),
        }));
      }
      for (const rule of rulesOnlyTheyUse(snap, { beneficiary, payee }, now())) todo.push(ix.endRule(ctx, owner, new PublicKey(rule.address)));
      must(todo.length, "BadStatus", "They are already out of this plan.");

      const txs: TxResult[] = [];
      for (const group of pack(todo)) txs.push(await d.send(group));
      return txs;
    },
  };
}
