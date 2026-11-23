/**
 * The second security review's rehearsal (plan.md §18.6 gate 5) on throwaway estates: a living claim, a death to
 * payout, a co-signed sale, and the refusals R1-R9 and R18-R20, each asserted on the chain.
 *
 * A refusal is sent without preflight, so it lands as a failed transaction and can be looked up. Every wallet is
 * generated in memory. Their leftover SOL goes back to the payer at the end.
 *
 * This file takes any connection: rehearse-second-review.ts is the command, and it only accepts devnet.
 */
import {
  Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction, type Connection, type TransactionInstruction,
} from "@solana/web3.js";
import {
  AuthorityType, MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToCheckedInstruction, createSetAuthorityInstruction,
} from "@solana/spl-token";
import * as ix from "../app/src/lib/chain/instructions";
import { getIdl } from "../app/src/lib/chain/idl";
import { assetPda, ata, claimPda, estatePda, guardPda, rulePda, seatPda, fallbackReportPda, vaultAta } from "../app/src/lib/chain/pda";
import { decodeEstate, key, num, enumOf } from "../app/src/lib/chain/decoders";
import { fetchAccountRaw } from "../app/src/lib/chain/reads";
import { tokenAmount } from "../app/src/lib/chain/balances";
import { PROGRAM_ERRORS } from "../app/src/lib/chain/program-errors";
import { publicBeneficiaryLabel, publicPayeeName } from "../app/src/lib/chain/public-names";
import { checkSaleTx, saleTransaction } from "../app/src/lib/agent/sale";
import { sha256Hex } from "../app/src/lib/agent/hash";

/** Throwaway wallets get about 0.4 SOL between them, and most of it comes back. */
export const REHEARSAL_MIN_LAMPORTS = 600_000_000;
export const REHEARSAL_PLAN = [
  "A living claim: submitted, reviewed, approved by the living owner, paid",
  "R3: a trusted person's approval is refused while the owner lives",
  "R1: a check-in during the waiting period clears the claim, and nothing can finish the unlock",
  "Death to payout: report, review, two confirmations, the wait, the unlock, a claim approved and paid",
  "A co-signed sale of the car's title; R19: another amount is refused, and so is a sale with no co-signer",
  "R20: an approved death report holds the sweep until the recipient says they are alive",
  "R5: a death claim is replaced only once stale, and the agent's review of the replaced one is refused",
  "R6: a stranger's seat report is refused, and a stale one gives way",
  "R2: replacing a trusted person clears the claim they attested",
  "R8: one survivor reaches the quorum",
  "R18: an active beneficiary confirms the last unwatched holder's death, and that stands after the owner's check-in",
  "R4: a fallback death needs the agent, a wait and a second person, and the recipient can refute it",
  "R9: one wallet that monitors two seats has one vote",
  "R7: a referred death with every seat vacant pays by the fallback plan after twice the wait",
] as const;

const USDT = 1_000_000n;
const WAITING = 60;
const FALLBACK_WAIT = 45;
/** Chain time past a deadline before acting on it. */
const MARGIN = 3;

export interface RehearsalStep {
  check: string;
  what: string;
  /** The program error it was refused with. */
  refused?: string;
  signature?: string;
  explorer?: string;
}
export interface RehearsalResult { ok: boolean; error?: string; estates: Record<string, string>; steps: RehearsalStep[] }
export interface RehearsalOptions {
  conn: Connection;
  payer: Keypair;
  explorer(signature: string): string;
  log?(line: string): void;
}

export async function rehearse({ conn, payer, explorer, log = () => undefined }: RehearsalOptions): Promise<RehearsalResult> {
  const result: RehearsalResult = { ok: false, estates: {}, steps: [] };
  const programId = new PublicKey(getIdl().address);
  const people: Keypair[] = [];
  const funds: [PublicKey, number][] = [];
  const person = (lamports = 0): Keypair => {
    const k = Keypair.generate();
    people.push(k);
    if (lamports) funds.push([k.publicKey, lamports]);
    return k;
  };

  function assert(ok: unknown, what: string): asserts ok {
    if (!ok) throw new Error(`Assertion failed: ${what}`);
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function statusOf(signature: string): Promise<unknown> {
    for (let i = 0; i < 120; i++) {
      const s = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (s && (s.err || s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        // A failure counts once it is confirmed too, so the next read sees the same chain.
        if (s.confirmationStatus !== "processed") return s.err;
      }
      await pause(500);
    }
    throw new Error(`Not confirmed in time: ${explorer(signature)}`);
  }

  async function land(ixs: TransactionInstruction[], signers: Keypair[], skipPreflight: boolean, feePayer = payer): Promise<{ signature: string; err: unknown }> {
    const tx = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: (await conn.getLatestBlockhash("confirmed")).blockhash }).add(...ixs);
    tx.sign(...new Map([feePayer, ...signers].map((s) => [s.publicKey.toBase58(), s])).values());
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight, preflightCommitment: "confirmed", maxRetries: 8 });
    return { signature, err: await statusOf(signature) };
  }

  function record(step: RehearsalStep): void {
    result.steps.push({ ...step, ...(step.signature ? { explorer: explorer(step.signature) } : {}) });
    log(`${step.refused ? `refused ${step.refused}` : "ok"} | ${step.check} | ${step.what}`);
  }

  async function does(check: string, what: string, ixs: TransactionInstruction[], signers: Keypair[] = [], feePayer = payer): Promise<string> {
    const { signature, err } = await land(ixs, signers, false, feePayer);
    assert(!err, `${what}: ${JSON.stringify(err)} ${explorer(signature)}`);
    record({ check, what, signature });
    return signature;
  }

  async function refuses(check: string, what: string, error: (typeof PROGRAM_ERRORS)[number], ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<void> {
    const { signature, err } = await land(ixs, signers, true);
    const custom = (err as { InstructionError?: [number, { Custom?: number }] } | null)?.InstructionError?.[1]?.Custom;
    const expected = 6000 + PROGRAM_ERRORS.indexOf(error);
    assert(custom === expected, `${what}: expected ${error} ${expected}, got ${JSON.stringify(err)} ${explorer(signature)}`);
    record({ check, what, refused: error, signature });
  }

  function proven(check: string, what: string, ok: unknown): void {
    assert(ok, what);
    record({ check, what });
  }

  async function chainTime(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
    return Number(Buffer.from(info!.data).readBigInt64LE(32));
  }

  async function until(when: number): Promise<void> {
    for (let left = when - (await chainTime()); left > 0; left = when - (await chainTime())) {
      log(`waiting about ${left} s`);
      await pause(Math.min(15, Math.max(1, left)) * 1000);
    }
  }

  async function raw(type: string, address: PublicKey) {
    return fetchAccountRaw(type, address.toBase58(), conn);
  }
  async function must(type: string, address: PublicKey) {
    const account = await raw(type, address);
    assert(account, `${type} ${address.toBase58()} exists`);
    return account;
  }
  const estateNow = async (estate: PublicKey) => decodeEstate(estate.toBase58(), await must("Estate", estate), 0n);
  const balance = async (account: PublicKey) => tokenAmount((await conn.getAccountInfo(account, "confirmed"))?.data);

  const H = (s: string) => sha256Hex(`heirloom-rehearsal:${s}`);
  const usdt = Keypair.generate();
  const ctx: ix.Ctx = { programId, usdtMint: usdt.publicKey };

  /** An estate with a Guard, three seats and its family. `watched[i]`: seat i's monitors. */
  async function newEstate(name: string, p: {
    owner: Keypair; agent: Keypair; trusted: Keypair[]; family: Keypair[]; fallback: Keypair[]; watched: Keypair[][]; fallbackWait: number; deposit: bigint;
  }): Promise<PublicKey> {
    const { owner, agent } = p;
    const o = owner.publicKey;
    const estate = estatePda(programId, o);
    const ownerUsdt = ata(usdt.publicKey, o);
    await does("setup", `${name}: estate and family`, [
      ix.createEstate(ctx, {
        owner: o, agent: agent.publicKey, verifiers: p.trusted.map((t) => t.publicKey) as [PublicKey, PublicKey, PublicKey],
        deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: WAITING,
      }),
      ...p.family.map((b, i) => ix.addBeneficiary(ctx, o, b.publicKey, publicBeneficiaryLabel(i))),
    ], [owner]);
    await does("setup", `${name}: test money in the vault`, [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ownerUsdt, o, usdt.publicKey),
      createMintToCheckedInstruction(usdt.publicKey, ownerUsdt, payer.publicKey, p.deposit, 6),
      ix.deposit(ctx, o, p.deposit),
    ], [owner]);
    await does("setup", `${name}: the Guard and the fallback list`, [
      ix.initGuard(ctx, o, estate, { objectionWindowSecs: 0, successionWaitSecs: 0, fallbackWaitSecs: p.fallbackWait }),
      ix.setFallback(ctx, o, p.fallback.map((f) => f.publicKey)),
    ], [owner]);
    await does("setup", `${name}: three seats`, p.watched.map((watchers, i) => ix.initSeat(ctx, o, i, [], watchers.map((m) => m.publicKey))), [owner]);
    result.estates[name] = estate.toBase58();
    return estate;
  }

  async function payoutSaleAndSweep(): Promise<void> {
    const [owner, agent] = [person(90_000_000), person(25_000_000)];
    const trusted = [person(8_000_000), person(), person()];
    const [child, school, monitor, buyer, recipient] = [person(20_000_000), person(), person(), person(15_000_000), person()];
    await fund();
    const [o, a, c] = [owner.publicKey, agent.publicKey, child.publicKey];
    const estate = await newEstate("payout", {
      owner, agent, trusted, family: [child], fallback: [recipient], watched: [[monitor], [monitor], [monitor]], fallbackWait: FALLBACK_WAIT, deposit: 30n * USDT,
    });
    const validUntil = (await chainTime()) + 30 * 86_400;
    const ruleOf = (ruleId: number, startsNow: boolean) => ix.addRule(ctx, o, {
      ruleId, beneficiaryWallet: c, category: "Tuition", allowedPayeeKind: "School", maxPerClaim: 5n * USDT, lifetimeCap: 5n * USDT, validUntil, startsNow,
    });
    await does("setup", "payout: the school and two rules", [
      ix.addPayee(ctx, o, school.publicKey, "School", publicPayeeName({ name: "Rehearsal School", kind: "School", wallet: school.publicKey.toBase58() }, new Set())),
      ruleOf(0, true), ruleOf(1, false),
    ], [owner]);

    const title = Keypair.generate();
    const titleAta = ata(title.publicKey, o);
    await does("setup", "a title with neither mint nor freeze authority", [
      SystemProgram.createAccount({
        fromPubkey: o, newAccountPubkey: title.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(title.publicKey, 0, o, null),
      createAssociatedTokenAccountIdempotentInstruction(o, titleAta, o, title.publicKey),
      createMintToCheckedInstruction(title.publicKey, titleAta, o, 1, 0),
      createSetAuthorityInstruction(title.publicKey, o, AuthorityType.MintTokens, null),
    ], [owner, title]);
    await does("setup", "the car registered, proceeds into the vault", [ix.registerAsset(ctx, o, {
      nftMint: title.publicKey, floorPrice: 10n * USDT, hardshipFloor: 8n * USDT, askingPrice: 12n * USDT, proceedsTo: estate, docHashHex: await H("car"),
    })], [owner]);
    const schoolUsdt = ata(usdt.publicKey, school.publicKey);

    // the living claim, and R3
    const rule0 = rulePda(programId, estate, 0);
    const claim0 = claimPda(programId, rule0, 0);
    await does("living claim", "the child asks", [ix.submitClaim(ctx, { estate, signer: c, ruleId: 0, claimId: 0, payeeWallet: school.publicKey, amount: 5n * USDT, evidenceHashHex: await H("living") })], [child]);
    await does("living claim", "the agent reviews", [ix.reviewClaim(estate, a, claim0, rule0, "Approve", await H("living report"))], [agent]);
    await refuses("R3", "a trusted person approves while the owner lives", "BadStatus", [ix.approveClaim(estate, trusted[0].publicKey, claim0, rule0)], [trusted[0]]);
    await does("living claim", "the owner approves", [ix.ownerApproveClaim(ctx, o, claim0, rule0)], [owner]);
    await does("living claim", "paid to the school", [ix.executeClaim(ctx, { estate, payer: payer.publicKey, rule: rule0, claim: claim0, beneficiary: c, payeeWallet: school.publicKey })]);
    proven("living claim", "the school holds 5 USDT", (await balance(schoolUsdt)) === 5n * USDT);

    async function confirmedDeath(check: string, label: string): Promise<void> {
      const cert = await H(label);
      await does(check, "the child reports the passing", [ix.submitDeathClaim(ctx, estate, c, cert)], [child]);
      await does(check, "the agent reviews that certificate", [ix.reviewDeath(estate, a, "Approve", await H(`${label} report`), cert)], [agent]);
      for (const t of trusted.slice(0, 2)) await does(check, "a trusted person confirms", [ix.attestDeath(estate, t.publicKey)], [t]);
      proven(check, "the waiting period runs", (await estateNow(estate)).status === "DeathPending");
    }

    // R1
    await confirmedDeath("R1", "first death");
    await does("R1", "the owner checks in", [ix.heartbeat(ctx, o)], [owner]);
    const alive = await estateNow(estate);
    proven("R1", "Active again, with no claim and no countdown", alive.status === "Active" && !alive.death.certHash && alive.death.pendingSince === null);
    await refuses("R1", "finishing the unlock", "BadStatus", [ix.finalizeUnlock(estate, payer.publicKey)]);
    await refuses("R1", "confirming the cleared claim", "NoDeathClaim", [ix.attestDeath(estate, trusted[2].publicKey)], [trusted[2]]);

    // death to payout
    await confirmedDeath("death to payout", "second death");
    await refuses("death to payout", "unlocking before the wait", "WaitingPeriodNotOver", [ix.finalizeUnlock(estate, payer.publicKey)]);
    await until((await estateNow(estate)).death.pendingSince! + WAITING + MARGIN);
    await does("death to payout", "unlocked", [ix.finalizeUnlock(estate, payer.publicKey)]);
    const rule1 = rulePda(programId, estate, 1);
    const claim1 = claimPda(programId, rule1, 0);
    await does("death to payout", "the child claims", [ix.submitClaim(ctx, { estate, signer: c, ruleId: 1, claimId: 0, payeeWallet: school.publicKey, amount: 5n * USDT, evidenceHashHex: await H("legacy") })], [child]);
    await does("death to payout", "the agent reviews", [ix.reviewClaim(estate, a, claim1, rule1, "Approve", await H("legacy report"))], [agent]);
    await does("death to payout", "a trusted person approves", [ix.approveClaim(estate, trusted[0].publicKey, claim1, rule1)], [trusted[0]]);
    await does("death to payout", "paid to the school", [ix.executeClaim(ctx, { estate, payer: payer.publicKey, rule: rule1, claim: claim1, beneficiary: c, payeeWallet: school.publicKey })]);
    proven("death to payout", "the school holds 10 USDT", (await balance(schoolUsdt)) === 10n * USDT);

    // the sale, and R19
    const asset = assetPda(programId, estate, title.publicKey);
    const buyerUsdt = ata(usdt.publicKey, buyer.publicKey);
    await does("sale", "listed", [ix.listAsset(estate, a, asset, 3_600)], [agent]);
    await does("sale", "an offer of 11 USDT in escrow", [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, buyerUsdt, buyer.publicKey, usdt.publicKey),
      createMintToCheckedInstruction(usdt.publicKey, buyerUsdt, payer.publicKey, 11n * USDT, 6),
      ix.placeOffer(ctx, estate, asset, buyer.publicKey, 11n * USDT),
    ], [buyer]);
    const terms = { estate, agent: a, asset, nftMint: title.publicKey, buyer: buyer.publicKey, recipient: estate };
    await refuses("R19", "the sale at another amount", "OfferChanged", [ix.acceptOffer(ctx, { ...terms, expectedAmount: 10n * USDT, coSigner: trusted[0].publicKey })], [agent, trusted[0]]);
    await refuses("R19", "the agent alone", "CoSignerRequired", [ix.acceptOffer(ctx, { ...terms, expectedAmount: 11n * USDT, coSigner: null })], [agent]);
    const sale = {
      estate: estate.toBase58(), agent: a.toBase58(), coSigner: trusted[0].publicKey.toBase58(),
      asset: { address: asset.toBase58(), nftMint: title.publicKey.toBase58(), proceedsTo: estate.toBase58(), hardshipBeneficiary: null },
      offer: { buyer: buyer.publicKey.toBase58(), amount: 11n * USDT },
    };
    const tx = saleTransaction(ctx, sale, (await conn.getLatestBlockhash("confirmed")).blockhash);
    tx.partialSign(trusted[0]);
    const checked = checkSaleTx(tx.serialize({ requireAllSignatures: false, verifySignatures: false }), ctx, sale);
    checked.partialSign(agent);
    const sold = await conn.sendRawTransaction(checked.serialize(), { preflightCommitment: "confirmed", maxRetries: 8 });
    assert(!(await statusOf(sold)), "the co-signed sale lands");
    record({ check: "sale", what: "co-signed and checked byte for byte: title and money swap", signature: sold });
    proven("sale", "the buyer holds the title", (await balance(ata(title.publicKey, buyer.publicKey))) === 1n);
    proven("sale", "the money is in the vault", (await balance(vaultAta(usdt.publicKey, estate))) === 31n * USDT);

    // R20
    const reporter = trusted[0];
    const cert = await H("recipient");
    await does("R20", "the next recipient is reported dead", [ix.reportFallbackDeath(ctx, reporter.publicKey, estate, 0, cert)], [reporter]);
    await does("R20", "the agent approves the report", [ix.reviewFallbackDeath(estate, a, 0, true, await H("recipient report"), cert, reporter.publicKey, recipient.publicKey)], [agent]);
    const sweep = ix.sweepResidual(ctx, { payer: payer.publicKey, estate, recipient: recipient.publicKey, reportIndex: 0, rules: [rule0, rule1] });
    await refuses("R20", "a sweep to them", "DeathReportOpen", [sweep]);
    await does("R20", "they say they are alive, and the sweep pays them", [
      ix.resolveFallbackDeath(ctx, { signer: recipient.publicKey, estate, index: 0, dead: false, rentTo: reporter.publicKey }), sweep,
    ], [recipient]);
    proven("R20", "the recipient holds the 31 USDT", (await balance(ata(usdt.publicKey, recipient.publicKey))) === 31n * USDT);
  }

  async function replacedReports(): Promise<void> {
    const [owner, agent] = [person(60_000_000), person()];
    const trusted = [person(), person(), person()];
    const [first, second, stranger, monitor, newHolder, recipient] = [person(), person(), person(), person(), person(), person()];
    await fund();
    const [o, a] = [owner.publicKey, agent.publicKey];
    const estate = await newEstate("reports", {
      owner, agent, trusted, family: [first, second], fallback: [recipient], watched: [[monitor], [monitor], [monitor]], fallbackWait: FALLBACK_WAIT, deposit: USDT,
    });
    const [c1, c2, s1, s2] = await Promise.all(["claim 1", "claim 2", "seat 1", "seat 2"].map(H));
    await does("R5", "a first death claim", [ix.submitDeathClaim(ctx, estate, first.publicKey, c1)], [first]);
    await refuses("R5", "replacing it at once", "BadStatus", [ix.submitDeathClaim(ctx, estate, second.publicKey, c2)], [second]);
    await refuses("R6", "a stranger reports a trusted person dead", "NotParticipant", [ix.reportSeatDeath(ctx, stranger.publicKey, estate, 1, s1)], [stranger]);
    await does("R6", "a family member's seat report", [ix.reportSeatDeath(ctx, first.publicKey, estate, 1, s1, { beneficiary: true })], [first]);
    await refuses("R6", "replacing that at once", "SuccessionPending", [ix.reportSeatDeath(ctx, second.publicKey, estate, 1, s2, { beneficiary: true })], [second]);

    await until(num(await must("Seat", seatPda(programId, estate, 1)), "death_pending_since") + WAITING + MARGIN);
    await does("R5", "a stale claim is replaced", [ix.submitDeathClaim(ctx, estate, second.publicKey, c2)], [second]);
    await refuses("R5", "the agent's review of the replaced claim", "ReportChanged", [ix.reviewDeath(estate, a, "Approve", await H("c1 report"), c1)], [agent]);
    await does("R6", "a stale seat report gives way", [ix.reportSeatDeath(ctx, second.publicKey, estate, 1, s2, { beneficiary: true })], [second]);
    await refuses("R6", "the agent's review of the replaced report", "ReportChanged", [ix.reviewSeatDeath(estate, a, 1, true, await H("s1 report"), s1, trusted[1].publicKey)], [agent]);

    await does("R2", "the agent reviews the claim that stands", [ix.reviewDeath(estate, a, "Approve", await H("c2 report"), c2)], [agent]);
    await does("R2", "a trusted person attests", [ix.attestDeath(estate, trusted[0].publicKey)], [trusted[0]]);
    await does("R2", "the owner replaces them", [ix.ownerReplaceSeat(ctx, o, 0, newHolder.publicKey)], [owner]);
    const after = await estateNow(estate);
    proven("R2", "the claim and the attestation are gone", !after.death.certHash && !after.death.attestations.some(Boolean));
    await refuses("R2", "the replaced person attests", "NotVerifier", [ix.attestDeath(estate, trusted[0].publicKey)], [trusted[0]]);
    await refuses("R2", "nothing is left to confirm", "NoDeathClaim", [ix.attestDeath(estate, trusted[1].publicKey)], [trusted[1]]);
  }

  async function lastSurvivorAndFallback(): Promise<void> {
    const [owner, agent] = [person(60_000_000), person()];
    const trusted = [person(), person(), person()];
    const [first, second, stranger, monitor, next, after] = [person(10_000_000), person(10_000_000), person(5_000_000), person(), person(), person()];
    await fund();
    const [o, a] = [owner.publicKey, agent.publicKey];
    const estate = await newEstate("fallback", {
      owner, agent, trusted, family: [first, second], fallback: [next, after],
      watched: [[monitor], [monitor], []], // seat 2 unwatched on purpose: R18
      fallbackWait: FALLBACK_WAIT, deposit: 7n * USDT,
    });
    const guard = guardPda(programId, estate);

    for (const i of [0, 1]) {
      const confirmer = trusted[i + 1];
      const cert = await H(`seat ${i}`);
      await does("setup", `seat ${i}: reported`, [ix.reportSeatDeath(ctx, first.publicKey, estate, i, cert, { beneficiary: true })], [first]);
      await does("setup", `seat ${i}: reviewed`, [ix.reviewSeatDeath(estate, a, i, true, await H(`seat ${i} report`), cert, trusted[i].publicKey)], [agent]);
      await does("setup", `seat ${i}: confirmed`, [ix.confirmSeatDeath(ctx, confirmer.publicKey, estate, i)], [confirmer]);
      await does("setup", `seat ${i}: vacant`, [ix.finalizeSuccession(ctx, estate, i, payer.publicKey)]);
    }

    const lone = await H("lone death");
    await does("R8", "a death claim", [ix.submitDeathClaim(ctx, estate, first.publicKey, lone)], [first]);
    await does("R8", "reviewed", [ix.reviewDeath(estate, a, "Approve", await H("lone report"), lone)], [agent]);
    await does("R8", "the only survivor confirms", [ix.attestDeath(estate, trusted[2].publicKey)], [trusted[2]]);
    proven("R8", "one of one is a quorum where two were needed", (await estateNow(estate)).status === "DeathPending");
    await does("R8", "the owner checks in", [ix.heartbeat(ctx, o)], [owner]);

    const lastSeat = await H("seat 2");
    await does("R18", "the last holder is reported dead", [ix.reportSeatDeath(ctx, first.publicKey, estate, 2, lastSeat, { beneficiary: true })], [first]);
    await does("R18", "reviewed", [ix.reviewSeatDeath(estate, a, 2, true, await H("seat 2 report"), lastSeat, trusted[2].publicKey)], [agent]);
    await refuses("R18", "the reporter confirms", "NotConfirmer", [ix.confirmSeatDeath(ctx, first.publicKey, estate, 2, { beneficiary: true })], [first]);
    await does("R18", "another beneficiary confirms", [ix.confirmSeatDeath(ctx, second.publicKey, estate, 2, { beneficiary: true })], [second]);
    await does("R18", "the owner checks in after it", [ix.heartbeat(ctx, o)], [owner]);
    // The program reads no remaining account any more: the beneficiary's confirmation stands on its own.
    await does("R18", "the confirmation stands", [ix.finalizeSuccession(ctx, estate, 2, payer.publicKey)]);
    const last = await must("Seat", seatPda(programId, estate, 2));
    proven("R18", "the last seat is vacant", key(last, "holder") === PublicKey.default.toBase58());

    await until((await chainTime()) + 2); // a countdown only counts if it starts after the check-in's second
    const referred = await H("referred death");
    await does("R7", "a death claim with every seat vacant", [ix.submitDeathClaim(ctx, estate, first.publicKey, referred)], [first]);
    await does("R7", "the agent refers it", [ix.reviewDeath(estate, a, "Refer", await H("referred report"), referred)], [agent]);
    await does("R7", "the fallback starts", [ix.startFallback(ctx, estate, payer.publicKey)]);
    const started = num(await must("Guard", guard), "fallback_started_at");

    const died = await H("second recipient");
    await refuses("R4", "a stranger reports a recipient dead", "NotParticipant", [ix.reportFallbackDeath(ctx, stranger.publicKey, estate, 1, died)], [stranger]);
    await does("R4", "a family member reports", [ix.reportFallbackDeath(ctx, first.publicKey, estate, 1, died, { beneficiary: true })], [first]);
    await does("R4", "the agent approves", [ix.reviewFallbackDeath(estate, a, 1, true, await H("second recipient report"), died, first.publicKey, after.publicKey)], [agent]);
    const report = await must("FallbackReport", fallbackReportPda(programId, estate, 1));
    proven("R4", "the agent's approval alone marks nobody dead",
      num(await must("Guard", guard), "fallback_dead") === 0 && enumOf(report, "verdict", ["Pending", "Approved"] as const) === "Approved");
    const resolve = (signer: Keypair, dead: boolean) => ix.resolveFallbackDeath(ctx, {
      signer: signer.publicKey, estate, index: 1, dead, rentTo: first.publicKey, as: dead ? { beneficiary: true } : {},
    });
    await refuses("R4", "the reporter confirms", "NotConfirmer", [resolve(first, true)], [first]);
    await refuses("R4", "a second person confirms before the wait", "WaitingPeriodNotOver", [resolve(second, true)], [second]);
    await does("R4", "the recipient says they are alive", [resolve(after, false)], [after]);

    await does("R9", "a family member objects to the fallback", [ix.raiseObjection(ctx, {
      objector: second.publicKey, estate, kind: "Fallback", target: guard, seatIndex: null, reasonHashHex: await H("objection"), monitorSeat: null, beneficiary: true,
    })], [second]);
    const vote = () => ix.voteObjection(ctx, { voter: monitor.publicKey, estate, kind: "Fallback", target: guard, uphold: false });
    await does("R9", "a monitor of two seats votes", [vote()], [monitor]);
    await refuses("R9", "and votes from the second seat", "AlreadyApproved", [vote()], [monitor]);

    const pay = () => ix.executeFallback(ctx, { payer: payer.publicKey, estate, recipient: next.publicKey, recipientIndex: 0 });
    await until(started + FALLBACK_WAIT + 1);
    await refuses("R7", "paying after one wait", "WaitingPeriodNotOver", [pay()]);
    // Also past the objection's lapse: it was raised within the countdown's first wait.
    await until(started + 2 * FALLBACK_WAIT + MARGIN);
    await does("R7", "paying after two", [pay()]);
    proven("R7", "the next recipient holds the vault", (await balance(ata(usdt.publicKey, next.publicKey))) === 7n * USDT);
  }

  async function fund(): Promise<void> {
    const todo = funds.splice(0);
    for (let i = 0; i < todo.length; i += 8) {
      await does("setup", "SOL for throwaway wallets", todo.slice(i, i + 8).map(([toPubkey, lamports]) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey, lamports })));
    }
  }

  async function giveBack(): Promise<void> {
    const held: { who: Keypair; lamports: number }[] = [];
    for (const who of people) {
      const lamports = await conn.getBalance(who.publicKey, "confirmed");
      if (lamports) held.push({ who, lamports });
    }
    for (let i = 0; i < held.length; i += 5) {
      const batch = held.slice(i, i + 5);
      await does("cleanup", "leftover SOL back to the payer",
        batch.map((h) => SystemProgram.transfer({ fromPubkey: h.who.publicKey, toPubkey: payer.publicKey, lamports: h.lamports })), batch.map((h) => h.who));
    }
  }

  try {
    const have = await conn.getBalance(payer.publicKey, "confirmed");
    assert(have >= REHEARSAL_MIN_LAMPORTS, `the payer needs ${REHEARSAL_MIN_LAMPORTS / 1e9} SOL`);
    await does("setup", "a throwaway test USDT mint", [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: usdt.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(usdt.publicKey, 6, payer.publicKey, null),
    ], [usdt]);
    await payoutSaleAndSweep();
    await replacedReports();
    await lastSurvivorAndFallback();
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message.replace(/(https?|wss?):\/\/[^\s?]+\?\S+/g, "[url]") : String(e);
  }
  try {
    await giveBack();
  } catch (e) {
    log(`could not return all leftover SOL: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}
