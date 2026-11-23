/**
 * Mock twin of the program's continuity instructions from the second review (plan §18.2 R15, R16; spec): replacing the
 * agent, taking an asset back and removing a beneficiary or payee. Same checks and error names as the program.
 */
import type { Base58 } from "../types";
import type { EstateSnapshot, TxResult } from "./types";
import type { AgentVoteInfo, RemoveMemberInput } from "../continuity/types";
import { rulesEndedByRemoval } from "../continuity/logic";
import { agentVoteFrom, agentVotesNeeded, deathSince, isHeld } from "../guardians/decisions";
import { eligibleSeats } from "../death-rules";
import { fail, need } from "./mock-errors";
import { proofOfLife } from "./mock-rules";
import { shortName } from "../names";

/** AgentVote accounts by candidate: who voted from each seat, and which agent they replace. */
export type MockAgentVotes = Record<Base58, { replaces: Base58; voters: (Base58 | null)[] }>;

export interface ContinuityDeps {
  snap(): EstateSnapshot;
  names(): Record<Base58, string>;
  votes(): MockAgentVotes;
  /** An asset keeps its address by title, so its photos are found again when it is registered again. */
  released(): Record<Base58, Base58>;
  /** Who a sweep would pay now. */
  residual(): Base58 | null;
  created(): boolean;
  me(): Base58;
  now(): number;
  tx(): TxResult;
  log(kind: string, text: string, t: TxResult): void;
  /** Seats and fallback reports the old agent reviewed go back to Pending for the new one (mock-guardians.ts). */
  clearAgentReviews(): void;
  /** A candidate agent can't be anyone's backup. */
  isBackup(w: Base58): boolean;
}

export function createMockContinuity(d: ContinuityDeps) {
  const est = () => d.snap().estate;
  const first = (w: Base58) => shortName(d.names()[w] ?? "Someone");
  const needCreated = () => need(d.created(), "NoEstate", "There is no estate yet. The owner signs the will first.");
  const needOwnerActive = (what: string) => {
    needCreated();
    need(d.me() === est().owner, "NotOwner", "Only the estate owner can do this.");
    need(est().status === "Active", "BadStatus", what);
  };

  function checkCandidate(w: Base58) {
    const e = est();
    need(isHeld(w) && w !== e.agent && w !== e.owner && !e.verifiers.includes(w) && !d.isBackup(w), "BadAgent",
      "The new agent must be another wallet that is neither the owner, a trusted person nor anyone's backup.");
  }

  /** What the old agent reviewed is the new one's to review again; then the agent changes. */
  function changeAgent(w: Base58) {
    est().agent = w;
    d.names()[w] ??= "Replacement agent";
    d.clearAgentReviews();
    d.log("AgentChanged", "The agent was replaced. The old one can no longer review, list or sign sales", d.tx());
  }

  /** set_agent: proof of life, which also voids the old agent's death review. */
  function setAgent(input: Base58): TxResult {
    const w = input.trim();
    needOwnerActive("The agent can only be replaced by the owner while the estate is active.");
    checkCandidate(w);
    const t = d.tx();
    proofOfLife(est(), d.now(), d.log, d.tx);
    changeAgent(w);
    return t;
  }

  /** vote_agent: all of them (at least two) while Active, afterwards two or the only one left. */
  function voteAgent(input: Base58): TxResult {
    needCreated();
    const w = input.trim();
    const e = est();
    const me = d.me();
    const i = isHeld(me) ? e.verifiers.indexOf(me) : -1;
    need(i >= 0, "NotVerifier", "Only one of the trusted people can do this.");
    checkCandidate(w);
    // The only trusted person left who would gain waits twice the recovery timeout (lib/guardians/decisions.ts).
    const from = agentVoteFrom(d.snap(), me);
    need(from === null || d.now() >= from, "WaitingPeriodNotOver", "You are the only trusted person left and you would gain, so your vote can't count yet.");
    const stored = d.votes()[w];
    const voters = stored?.replaces === e.agent ? [...stored.voters] : [null, null, null];
    const firstTime = voters[i] !== me;
    voters[i] = me;
    const got = eligibleSeats(e.verifiers).filter((j) => voters[j] === e.verifiers[j]).length;
    const needed = agentVotesNeeded(e, d.now());
    need(firstTime || got >= needed, "AlreadyApproved", "You have already voted for this agent.");
    const t = d.tx();
    d.votes()[w] = { replaces: e.agent, voters };
    d.log("AgentVoted", `${first(me)} voted to replace the agent (${got} of ${needed})`, t);
    if (got >= needed) {
      d.votes()[w].voters = [null, null, null];
      // The death claim's review was the old agent's: the new one reviews it again, and the wait starts over.
      const death = e.death;
      if (death.certHash && e.lastHeartbeat <= deathSince(e) && e.status !== "Unlocked" && death.verdict !== "Pending") {
        Object.assign(death, { verdict: "Pending", attestations: [false, false, false], agentReport: undefined, decidedAlone: false, pendingSince: null, submittedAt: d.now() });
        e.status = "Active";
        d.log("AgentReviewCleared", "The new agent will review the reported passing again, and the wait starts over", d.tx());
      }
      changeAgent(w);
    }
    return t;
  }

  /** The open votes to replace today's agent, by people who still hold their seat. */
  function agentVotes(): AgentVoteInfo[] {
    const e = est();
    return Object.entries(d.votes()).flatMap(([candidate, v]) => {
      const voters = v.replaces === e.agent ? e.verifiers.filter((w, i) => isHeld(w) && v.voters[i] === w) : [];
      return voters.length ? [{ candidate, voters }] : [];
    });
  }

  function releaseAsset(address: Base58): TxResult {
    needOwnerActive("An asset can only be taken back while the estate is active.");
    const sn = d.snap();
    const a = sn.assets.find((x) => x.address === address) ?? fail("BadStatus", "That asset does not exist.");
    need(a.status === "Held", "BadStatus", "This asset is being sold or has been sold.");
    sn.assets = sn.assets.filter((x) => x !== a);
    d.released()[a.nftMint] = a.address;
    const t = d.tx();
    d.log("AssetReleased", `${first(sn.estate.owner)} took back ${a.title}. Its digital title is in the owner's wallet`, t);
    return t;
  }

  /** set_residual when needed, end_rule for what only they could use, then remove_member (proof of life). */
  function removeMember(input: RemoveMemberInput): TxResult[] {
    needOwnerActive("People can only be removed while the estate is active.");
    need(!!input.beneficiary || !!input.payee, "BadStatus", "Choose who to remove.");
    const sn = d.snap();
    const e = sn.estate;
    const named = input.beneficiary
      ? sn.beneficiaries.find((b) => b.wallet === input.beneficiary) ?? fail("NotBeneficiary", "That person is not in the plan.")
      : null;
    const person = named?.active ? named : null;
    const payee = input.payee
      ? sn.payees.find((p) => p.wallet === input.payee) ?? fail("AccountNotInitialized", "That payee has already been removed.")
      : null;
    const heir = input.newResidual;
    if (named) need(!!heir || d.residual() !== named.wallet, "residual", "Choose who receives what is left instead.");
    if (named && heir) {
      need(isHeld(heir) && heir !== named.wallet && heir !== e.owner && heir !== e.address && !sn.beneficiaries.some((b) => b.wallet === heir && !b.active),
        "residual", "Choose someone else to receive what is left: not you, the plan itself, or someone who was removed.");
    }
    const ended = rulesEndedByRemoval(sn, input, d.now());

    need(!!person || !!payee || !!(named && heir) || !!ended.length, "BadStatus", "They are already out of this plan.");

    // The chain's order: name who receives what is left, remove (proof of life), then end the rules.
    const txs: TxResult[] = [];
    const step = (kind: string, text: string) => { const t = d.tx(); txs.push(t); d.log(kind, text, t); };
    if (named && heir) {
      sn.residual = heir;
      step("ResidualSet", `${first(heir)} will receive whatever no rule needs`);
    }
    if (person) {
      person.active = false;
      step("MemberRemoved", `${first(person.wallet)} was removed from the plan. Their open claims and schedules can't pay`);
    }
    if (payee) {
      sn.payees = sn.payees.filter((p) => p !== payee);
      d.names()[payee.wallet] ??= payee.name;
      step("MemberRemoved", `${payee.name} was removed as an approved payee. Nothing more can be paid to it`);
    }
    if (person || payee) proofOfLife(e, d.now(), d.log, d.tx);
    for (const r of ended) {
      r.validUntil = d.now() - 1;
      step("RuleEnded", `A ${r.category.toLowerCase()} rule ended with the removal. It cannot pay any more`);
    }
    return txs;
  }

  /** add_beneficiary on one who was removed: in the plan again; ended rules stay ended. */
  function restoreMember(wallet: Base58): TxResult {
    needOwnerActive("People can only be added back while the estate is active.");
    const b = d.snap().beneficiaries.find((x) => x.wallet === wallet);
    need(!!b && !b.active, "BadStatus", "They aren't someone who was removed from this plan.");
    b!.active = true;
    const t = d.tx();
    d.log("BeneficiaryAdded", `${first(wallet)} is in the plan again`, t);
    return t;
  }

  return { setAgent, voteAgent, agentVotes, releaseAsset, removeMember, restoreMember };
}
