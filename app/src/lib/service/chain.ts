/**
 * HeirloomService on Solana devnet. Writes: build instructions → unsigned base64 tx → the active Tether WDK
 * wallet signs and sends (wallet/signer.ts, kept in sync by <WalletProvider>) → confirm. Reads: RPC + decoders.
 * Agent actions (reviews, listing, accepting offers, valuation, chat) go through our API routes, where the
 * agent's own WDK wallet signs only review_* / list_asset / accept_offer.
 */
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import type { HeirloomService, EstateSnapshot, TxResult } from "./types";
import type { Locale } from "../i18n/locales";
import type {
  AgentReport, Base58, CarValuation, FxRate, PaymentReceipt, PaymentReview, SavedRecipient, WillChatMessage, WillDraft,
} from "../types";
import { chainCtx } from "../chain/client";
import { chainConfig } from "../chain/config";
import * as ix from "../chain/instructions";
import { ata, beneficiaryPda, claimPda, estatePda, guardPda, offerPda, hardshipPda, stampPda } from "../chain/pda";
import { demoEstateFirst } from "../chain/demo-estate";
import { base64ToBytes, bytesToBase64, ChainTxError, getConnection } from "../chain/tx";
import {
  activityFrom, deathReviewHash, fetchAccountRaw, fetchEstateRaw, fetchEvents, fetchHistory, findEstateOf, invalidateProgramAccounts,
} from "../chain/reads";
import { assembleSnapshot } from "../chain/snapshot";
import { bool, enumOf, hex, key, keyArray, num, optKey, type Raw } from "../chain/decoders";
import { ChainServiceError, must, PaymentPending, reviewPending, writeFailure } from "./chain-errors";
import { mayAskToList } from "../agent/sale";
import { createChainContinuity } from "./chain-continuity";
import { deathClaimStep } from "./chain-reports";
import { checkPeople, planSetup } from "./chain-setup";
import { acceptBestOffer, reviveRanking, type WireRanking } from "./chain-sale";
import { loadSaleTiming } from "../chain/sale-timing";
import { getActiveSigner, peekActiveSigner } from "../wallet/signer";
import {
  defaultReceiptStore, feeForReview, newPaymentId, openReceipts, recheck, resumeOnReconnect, runPayment, sameOpen, signSponsoredOrSelf, SponsorError, waitForFinal,
  type ChainOps, type SponsorClient, type SponsorStatus, type StoredPayment,
} from "../wallet/payments";
import { readOnly } from "../wallet/wdk";
import { loadWallets } from "../wallet/store";
import { explorerTx, fromBase, toBase } from "../format";
import { hashJson, sha256Hex } from "../agent/hash";
import type { EstateMeta } from "../db";
import { signedMetaRequest } from "../estate-meta/signed";
import { createNamesKeeper } from "../estate-meta/keeper";
import { legacyApi, type LegacySigner } from "../legacy/client";
import { createChainGuardians, guardianExtras, loadGuardians, rememberOnDevice } from "./chain-guardians";
import { createChainDisputes, loadDisputes } from "./chain-disputes";
import { createChainAsk } from "./chain-ask";
import { estateRecipients, mergeRecipients } from "./recipients";
import type { TreeService } from "../tree/types";
import type { LettersService } from "../letters/types";
import { disabledGuardians } from "../chain/guardians";
import { estateRolesOf } from "../chain/estate-roles";
import { SystemProgram } from "@solana/web3.js";
import type { ActivityItem } from "../types";
import type { PaidBill } from "../bills/types";
import { billActivityText } from "../bills/book";
import type { InvoiceRead } from "../bills/invoice";
import {
  AuthorityType, MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction as createAtaIx,
  createInitializeMint2Instruction, createMintToInstruction, createSetAuthorityInstruction,
} from "@solana/spl-token";
import { actionHeaders, ensureReadPass, readHeaders, readerKey } from "../access/client";
import { actionBody, type AgentAction } from "../access/messages";
import { MIN_DEATH_THRESHOLD, clampDeathWaiting } from "../continuity/logic";
import { pack } from "../chain/pack";
import { requireCurrentApp } from "../chain/write-guard";
import { requireEvidence } from "../evidence";
import { createSigningStore, withChosenEvery } from "./signing-store";
import { loadReasons } from "../disputes/reasons-client";
import { publicBeneficiaryLabel, publicPayeeName, withPrivateNames } from "../chain/public-names";

// ---------- legacy voice: requests signed by the acting WDK wallet; the server checks the on-chain role ----------
function legacySigner(estate: Base58): LegacySigner {
  const s = getActiveSigner();
  return { estate, wallet: s.address, sign: (m) => s.signMessage(m), canSignQuietly: s.canSignQuietly ? () => s.canSignQuietly!() : undefined };
}

// ---------- small helpers ----------
const pk = (a: string) => new PublicKey(a);

// ---------- pay-once pipeline (wallet/payments.ts) ----------
const receipts = defaultReceiptStore();

// ---------- pay a bill once (lib/bills): the owner's own wallet, never the vault ----------
// The store validates with zod, so it (and the schemas) load the first time bills are used, not on every first visit.
const billSchemas = () => import("../bills/payees");
let billStore: ReturnType<Awaited<ReturnType<typeof billSchemas>>["billPayeeStore"]> | null = null;
const billBook = async () => (billStore ??= (await billSchemas()).billPayeeStore());

/** Bills this device paid from `wallet` (kept with the receipts), newest first. */
function billsFrom(wallet: Base58): PaidBill[] {
  return receipts.list()
    .filter((r) => r.kind === "bill" && r.bill && r.to && r.from === wallet)
    .map((r) => ({ id: r.id, to: r.to!, bill: r.bill!, amount: BigInt(r.amount ?? "0"), status: r.status, signature: r.signature, explorerUrl: r.explorerUrl, ts: Math.floor(r.updatedAt / 1000) }))
    .sort((a, b) => b.ts - a.ts);
}

/**
 * The owner's confirmed bills as activity lines, on the owner's own device only (the bills are not estate events,
 * so nobody else sees them; the public record drops them too, lib/audit.ts).
 */
function billActivity(estate: Base58, ownerName: string): ActivityItem[] {
  const me = peekActiveSigner()?.address;
  if (!me || estatePda(chainCtx().programId, me).toBase58() !== estate) return [];
  const usd = (b: bigint) => `${fromBase(b).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} USD₮`;
  return billsFrom(me).filter((b) => b.status === "confirmed")
    .map((b) => ({ ts: b.ts, kind: "BillPaid", text: billActivityText(ownerName.split(" ")[0] || "The owner", b.bill, usd(b.amount)), amount: b.amount, txSignature: b.signature }));
}

export function chainOps(): ChainOps {
  const conn = getConnection();
  return {
    status: async (sig) => (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0],
    blockHeight: () => conn.getBlockHeight("confirmed"),
    broadcast: async (wire) => { await conn.sendRawTransaction(base64ToBytes(wire), { maxRetries: 3 }); },
  };
}

// ---------- fee sponsorship: the server's agent WDK wallet pays network fees (/api/sponsor) ----------
let sponsorCache: { at: number; value: SponsorStatus | null } | null = null;

const sponsorClient: SponsorClient = {
  async status() {
    if (sponsorCache && Date.now() - sponsorCache.at < 60_000) return sponsorCache.value;
    const value = await api<SponsorStatus>("/api/sponsor").catch(() => null);
    sponsorCache = { at: Date.now(), value };
    return value;
  },
  async cosign(tx) {
    const res = await fetch("/api/sponsor", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, submit: false }) });
    const data = (await res.json().catch(() => ({}))) as { signature?: string; wireBase64?: string; error?: string; code?: string };
    if (!res.ok || !data.signature || !data.wireBase64) {
      if (res.status === 503) sponsorCache = { at: Date.now(), value: null }; // stop trying for a minute
      throw new SponsorError(data.code ?? `http_${res.status}`, data.error ?? `Fee sponsor refused (${res.status}).`);
    }
    return { signature: data.signature, wireBase64: data.wireBase64 };
  },
};

type Ixs = TransactionInstruction[] | ((feePayer: PublicKey) => TransactionInstruction[]);

/**
 * Builds the tx (fee payer = Heirloom's sponsor when available, else the user), WDK signs it (sign-only; partial
 * when sponsored, then the server co-signs), the signature is persisted, then broadcast; returns the receipt.
 */
async function pay(id: string, ixs: Ixs, meta: Pick<StoredPayment, "kind" | "to" | "toLabel" | "amount" | "from" | "bill">, selfPay = false, check?: () => Promise<void>) {
  // Before anything is signed: this tab's build is the server's, and the program on-chain is this build's (C1).
  await requireCurrentApp();
  const signer = getActiveSigner();
  return runPayment(receipts, chainOps(), id, async () => {
    const signed = await signFor(signer, ixs, selfPay);
    // Read again after the wallet signed (a PIN or a phone wallet can take a while): what was shown must still hold.
    // A refusal here throws before the signature is stored, so these bytes are never sent.
    if (check) await check();
    return signed;
  }, meta);
}

/**
 * The fee the review on screen showed (M3), while a payment it covers runs: Heirloom's ("sponsored") is never
 * swapped for the user's without showing it again, and a user-paid one never asks the sponsor. Payments run one at a
 * time from the review sheet, so one value is enough.
 */
let shownFee: { sponsored: boolean } | null = null;

function signFor(signer: ReturnType<typeof getActiveSigner>, ixs: Ixs, selfPayAsked: boolean) {
  const selfPay = selfPayAsked || shownFee?.sponsored === false;
  return signSponsoredOrSelf({
    requireSponsor: !selfPay && shownFee?.sponsored === true,
    user: signer.address,
    async build(feePayer) {
      const conn = getConnection();
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const list = typeof ixs === "function" ? ixs(pk(feePayer)) : ixs;
      const tx = new Transaction({ feePayer: pk(feePayer), blockhash, lastValidBlockHeight }).add(...list);
      return { base64: bytesToBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), lastValidBlockHeight };
    },
    signPartial: signer.signPartial ? (b64) => signer.signPartial!(b64) : undefined,
    signOnly: (b64) => signer.signOnly(b64),
    // A self-paid tx (a title mint: the sponsor never pays for mints) doesn't ask the sponsor at all.
    sponsor: selfPay ? undefined : sponsorClient,
    onFallback: (reason) => console.warn(`Fee sponsor unavailable, paying the fee from the wallet: ${reason}`),
  });
}

/** Runs `work` under the fee the review showed (see `shownFee`). */
async function withFee<T>(fee: { sponsored: boolean }, work: () => Promise<T>): Promise<T> {
  const before = shownFee;
  shownFee = { sponsored: fee.sponsored };
  try { return await work(); } finally { shownFee = before; }
}

/** Account sizes whose rent a payment may pay: a token account, an Offer (8 + 32 + 32 + 8 + 8 + 1), an ApprovalStamp. */
const TOKEN_ACCOUNT_SIZE = 165;
const OFFER_SIZE = 89;
const STAMP_SIZE = 82;

/** An identical payment still being checked (H8): a second one is never signed while the first may land. */
async function refuseIfStillChecking(meta: Pick<StoredPayment, "kind" | "to" | "amount" | "from">) {
  if (!meta.to || !meta.amount) return;
  for (const p of sameOpen(receipts, meta)) {
    const r = await recheck(receipts, chainOps(), p.id);
    if (r && ["signing", "submitted", "pending"].includes(r.status) && r.signature) {
      throw new PaymentPending(p.id, r.signature, p.kind, "StillChecking: the same payment was sent a moment ago and is still being checked. Wait for it before you send it again.");
    }
  }
}

/**
 * Every user-initiated program tx goes through the same pay-once pipeline and waits for confirmation. `ixs` may depend
 * on the fee payer (e.g. approve_claim lets the sponsor pay the approval stamp's rent when it is the fee payer).
 */
async function send(ixs: Ixs, meta: Pick<StoredPayment, "kind" | "to" | "toLabel" | "amount"> = { kind: "program" }, opts: { selfPay?: boolean; check?: () => Promise<void> } = {}): Promise<TxResult> {
  const from = getActiveSigner().address;
  await refuseIfStillChecking({ ...meta, from });
  const id = newPaymentId();
  const first = await pay(id, ixs, { ...meta, from }, opts.selfPay, opts.check);
  const r = first.status === "failed" ? first : await waitForFinal(receipts, chainOps(), id, 60_000, 800);
  written(); // also when it failed or is unconfirmed: the next read must see the chain as it is
  // Signed and sent, not settled: "submitted, checking" on this id, never a failure that invites a second payment.
  if (r?.signature && r.status !== "failed" && r.status !== "confirmed") throw new PaymentPending(id, r.signature, meta.kind);
  if (r?.status === "failed" && r.code) throw new ChainServiceError(r.code, r.error ?? r.code);
  const failure = writeFailure(r);
  if (failure) throw new ChainTxError(r?.signature ?? "", failure);
  return { signature: r!.signature!, explorerUrl: explorerTx(r!.signature!) };
}

/**
 * approve_claim and approve_hardship write an approval stamp whose rent the verifier pays, or the fee payer when that is
 * Heirloom's sponsor and it pays rent (its `payer` slot: SPONSOR_RENT_PAYER_ACCOUNTS).
 */
async function sendStampPaid(verifier: PublicKey, build: () => TransactionInstruction): Promise<TxResult> {
  const paysRent = Boolean((await sponsorClient.status().catch(() => null))?.paysRent);
  return send((feePayer) => {
    const t = build();
    const at = t.keys.findIndex((k, i) => i > 0 && k.pubkey.equals(verifier) && k.isWritable);
    if (at > 0 && paysRent && !feePayer.equals(verifier)) t.keys[at] = { ...t.keys[at], pubkey: feePayer };
    return [t];
  });
}

/**
 * Who reports the owner's death, as submit_death_claim checks it: an active beneficiary (their PDA goes along), a living
 * trusted person (nothing more), or a living listed fallback recipient (the Guard goes along); never the agent. Only an
 * account the signer holds is passed: an optional account that is passed has to exist.
 */
async function deathReporter(estate: Base58, raw: Raw, me: Base58): Promise<ix.DeathReporter> {
  const programId = chainCtx().programId;
  must(me !== key(raw, "agent"), "NotParticipant", "The agent never reports the owner's passing.");
  const ben = await fetchAccountRaw("Beneficiary", beneficiaryPda(programId, estate, me).toBase58());
  if (ben && bool(ben, "active")) return { beneficiary: true };
  if (keyArray(raw, "verifiers").includes(me)) return {};
  const guard = await fetchAccountRaw("Guard", guardPda(programId, estate).toBase58());
  const dead = guard ? num(guard, "fallback_dead") : 0;
  must(guard && keyArray(guard, "fallback").some((w, i) => w === me && w !== estate && (dead & (1 << i)) === 0), "NotParticipant",
    "Only the family in this plan, a trusted person or someone on the fallback list can report the owner's passing.");
  return { listed: true };
}

/** Something was written: the next read sees it. */
function written(): void {
  forget("activity:"); forget("estates:"); forget("history:"); forget("tree:"); invalidateProgramAccounts();
}

/** The estate from the chain now, not from a scan of a few seconds ago. */
function freshEstate(estate: Base58) {
  invalidateProgramAccounts();
  return fetchEstateRaw(estate);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Reads carry this wallet's read pass: family records are for members only (lib/access).
  const res = await fetch(path, { cache: "no-store", ...init, headers: { ...readHeaders(), ...(init?.headers as Record<string, string> | undefined) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { code: data.code });
  return data;
}
const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A request that makes the agent sign or spend: the active wallet signs it (lib/access). */
async function signedPost<T>(path: string, action: AgentAction, estate: Base58, body: unknown, signed: string): Promise<T> {
  const headers = { "content-type": "application/json", ...(await actionHeaders(getActiveSigner(), action, estate, signed)) };
  return api<T>(path, { method: "POST", headers, body: JSON.stringify(body) });
}


/** Rent for what a practice person does (a claim, a dispute, an offer). */
const PRACTICE_SOL_LAMPORTS = 6_000_000;

/** The owner's device copy of the names, put back quietly when the server lost them (lib/estate-meta/keeper.ts). */
/** The plan being signed, on the owner's device before the first transaction (H6). */
const signing = createSigningStore();

const namesKeeper = createNamesKeeper({
  signer: peekActiveSigner,
  owns: (estate, wallet) => estatePda(chainCtx().programId, wallet).toBase58() === estate,
  post: (body) => post("/api/estate-meta", body),
  storage: () => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } },
});

/**
 * Saves an estate's names (and, once, the signed will draft), signed by the owner's wallet (lib/estate-meta). The
 * wallet is usually unlocked right after the txs this follows, so the signature is quiet; a locked wallet asks for
 * the PIN now.
 */
async function saveMeta(meta: EstateMeta, draft?: WillDraft): Promise<void> {
  const payload = {
    ownerName: meta.ownerName, verifierNames: meta.verifierNames, assetTitles: meta.assetTitles, buyerNames: meta.buyerNames,
    basedOn: meta.updatedAt ?? 0,
    ...(draft ? { draft } : {}),
  };
  namesKeeper.remember(meta);
  const { updatedAt } = await post<{ updatedAt?: number }>("/api/estate-meta", await signedMetaRequest(getActiveSigner(), "save", meta.estate, payload));
  if (updatedAt !== undefined) namesKeeper.remember(meta, updatedAt);
  forget(`meta:${meta.estate}`);
}

const fileHash = async (f: File) => sha256Hex(new Uint8Array(await f.arrayBuffer()));


async function review(file: File, purpose: "death" | "claim" | "hardship" | "seat-death" | "fallback-death", estate: Base58, context: string, subject?: Base58, preview = false, index?: number) {
  const form = new FormData();
  form.set("file", file);
  form.set("purpose", purpose);
  form.set("estate", estate);
  form.set("context", context);
  if (subject) form.set("subject", subject);
  if (index !== undefined) form.set("index", String(index));
  if (preview) form.set("preview", "1");
  const headers = preview ? undefined
    : await actionHeaders(getActiveSigner(), "review", estate, actionBody.review({ purpose, subject, index, sha256: await fileHash(file) }));
  return api<{ report: AgentReport; tx: TxResult | null; onChain: string }>("/api/review", { method: "POST", body: form, headers });
}

function requireOwnerOf(estate: Base58): PublicKey {
  const me = getActiveSigner().address;
  if (estatePda(chainCtx().programId, me).toBase58() !== estate) throw new Error("Switch to the estate owner's wallet to do this.");
  return pk(me);
}

async function mustFetch(type: string, address: Base58): Promise<Raw> {
  const raw = await fetchAccountRaw(type, address);
  if (!raw) throw new Error(`${type} ${address.slice(0, 6)}… was not found on-chain.`);
  return raw;
}

/**
 * Short-lived memo for reads that rarely change. The public devnet RPC rate-limits hard (HTTP 429), and the
 * dashboard refreshes in the background, so repeating every program-account scan on each refresh would starve
 * the reads that matter. Failed lookups are not cached.
 */
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}
/** Call after a write so the next read sees it. */
const forget = (prefix: string) => { for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k); };

async function getMeta(estate: Base58): Promise<EstateMeta | null> {
  return cached(`meta:${estate}:${readerKey()}`, 60_000, () => api<EstateMeta | null>(`/api/estate-meta?estate=${estate}`)).catch(() => null);
}

/**
 * The names to change and save back. Takes the read pass first: without one the server answers with roles in place of
 * names, and saving that would erase the family's real names.
 */
async function getMetaForWrite(estate: Base58): Promise<EstateMeta | null> {
  await ensureReadPass(getActiveSigner());
  forget(`meta:${estate}`);
  return namesKeeper.view(estate, await getMeta(estate));
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Estates this wallet owns, inherits from, verifies, or stands by for as a monitor, backup or fallback recipient
 * (owner lookup is a PDA read; the rest is one program scan, chain/estate-roles.ts).
 */
async function listEstatesUncached(wallet: Base58) {
  const out: { estate: Base58; role: string; ownerName: string }[] = [];
  const own = await findEstateOf(wallet);
  if (own) out.push({ estate: own, role: "owner", ownerName: namesKeeper.view(own, await getMeta(own))?.ownerName ?? "You" });
  for (const { estate, role } of await estateRolesOf(wallet)) {
    if (role === "monitor" && estate === own) continue;
    out.push({ estate, role, ownerName: (await getMeta(estate))?.ownerName ?? "Family estate" });
  }
  return demoEstateFirst(out);
}

// ---------- the service ----------
let resumed = false;

/**
 * A fresh SPL title mint for a new asset (0 decimals, supply 1 in the owner's account, mint authority removed), at an
 * address derived from the owner + a random seed so only the owner signs. The asset PDA is then seeded by this mint.
 */
async function newTitleMint(owner: PublicKey): Promise<{ mint: PublicKey; ixs: TransactionInstruction[] }> {
  const seed = `heirloom-asset-${crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 16)}`;
  const mint = await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID);
  const lamports = await getConnection().getMinimumBalanceForRentExemption(MINT_SIZE);
  const ownerAta = ata(mint, owner);
  return {
    mint,
    ixs: [
      SystemProgram.createAccountWithSeed({ fromPubkey: owner, basePubkey: owner, seed, newAccountPubkey: mint, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint, 0, owner, null),
      createAtaIx(owner, ownerAta, owner, mint),
      createMintToInstruction(mint, ownerAta, owner, 1),
      createSetAuthorityInstruction(mint, owner, AuthorityType.MintTokens, null),
    ],
  };
}

export function createChainService(): HeirloomService {
  // Once per page: re-check payments left pending by an earlier visit, now and whenever the browser reconnects.
  if (!resumed && typeof window !== "undefined") { resumed = true; resumeOnReconnect(receipts, chainOps()); }
  // "Ask for money": a living claim plus its off-chain note (chain-ask.ts).
  const asks = createChainAsk({
    send: (ixs) => send(ixs),
    review: (file, estate, context, claim) => review(file, "claim", estate, context, claim),
    fetchRaw: (type, address) => fetchAccountRaw(type, address),
    requireOwnerOf,
  });
  // Trust Tree: the estate's full history, child plans and the family links (chain-tree.ts), loaded on first use so
  // the tree's code stays out of every other page.
  let treeService: Promise<TreeService> | null = null;
  const tree = () => (treeService ??= import("./chain-tree").then((m) => m.createChainTree({
    getEstate: (estate) => service.getEstate(estate),
    history: (estate) => cached(`history:${estate}`, 30_000, () => fetchHistory(estate)),
    findEstateOf: (wallet) => cached(`estateOf:${wallet}`, 60_000, () => findEstateOf(wallet)),
    assetKinds: async (estate) => Object.fromEntries((await service.getAssetMedia(estate)).map((m) => [m.asset, m.kind])),
    requireOwnerOf,
    signer: () => getActiveSigner(),
    deviceWallets: () => loadWallets().map((w) => ({ address: w.address, label: w.label })),
  })));
  // Letters for later: signed calls to /api/letters plus the owner's device copy (chain-letters.ts), loaded on first use.
  let lettersService: Promise<LettersService> | null = null;
  const letters = () => (lettersService ??= import("./chain-letters").then((m) => m.createChainLetters({
    getEstate: (estate) => service.getEstate(estate),
    signer: () => getActiveSigner(),
    usdtZar: async () => (await service.getFx()).usdtZar,
  })));
  // Continuity, removal, rule slots (chain-continuity.ts).
  const { residualOf, ...continuity } = createChainContinuity({
    send: (ixs, opts) => send(ixs, { kind: "program" }, opts),
    requireOwnerOf,
    fetchRaw: (type, address) => fetchAccountRaw(type, address),
    fetchEstate: freshEstate,
    accountExists: async (address) => !!(await getConnection().getAccountInfo(address, "confirmed")),
  });
  const service: HeirloomService = {
    mode: "chain",
    ...continuity,
    // Chip in (plan §21): found by the estate's tag, each checked against the vault's own token balances.
    listChipIns: (estate) => cached(`chipins:${estate}`, 15_000, async () => (await import("../chipin/find")).findChipIns(getConnection(), estate, chainCtx().usdtMint.toBase58())),
    listLetters: async (estate, opts) => (await letters()).listLetters(estate, opts),
    saveLetter: async (estate, input, version) => (await letters()).saveLetter(estate, input, version),
    deleteLetter: async (estate, id, version) => (await letters()).deleteLetter(estate, id, version),
    reviewLetter: async (estate, draft, locale) => (await letters()).reviewLetter(estate, draft, locale),
    suggestLetter: async (estate, input, locale) => (await letters()).suggestLetter(estate, input, locale),
    letterCounts: (estate) => cached(`letterCounts:${estate}`, 20_000, async () => (await letters()).letterCounts(estate)),
    getTree: (estate) => cached(`tree:${estate}:${readerKey()}`, 20_000, async () => {
      const t = await (await tree()).getTree(estate);
      // Older history still loading in the background: let the next read pick it up soon.
      if (t.partial) setTimeout(() => { forget(`tree:${estate}`); forget(`history:${estate}`); }, 5_000);
      return t;
    }),
    setRelationship: async (estate, input) => (await tree()).setRelationship(estate, input).finally(() => forget(`tree:${estate}`)),
    removeRelationship: async (estate, id) => (await tree()).removeRelationship(estate, id).finally(() => forget(`tree:${estate}`)),
    setHidden: async (estate, hidden) => (await tree()).setHidden(estate, hidden).finally(() => forget(`tree:${estate}`)),
    setPhoto: async (estate, person, src) => (await tree()).setPhoto(estate, person, src).finally(() => forget(`tree:${estate}`)),
    removePhoto: async (estate, person) => (await tree()).removePhoto(estate, person).finally(() => forget(`tree:${estate}`)),
    askForMoney: (estate, input) => asks.askForMoney(estate, input).finally(() => forget(`asks:${estate}`)),
    declineAsk: (estate, claim) => asks.declineAsk(estate, claim).finally(() => forget(`asks:${estate}`)),
    ...createChainGuardians({
      send: (ixs) => send(ixs),
      review: (file, purpose, estate, context, index) => review(file, purpose, estate, context, undefined, false, index),
      getMeta,
      saveMeta: (meta) => saveMeta(meta),
      getMetaForWrite,
      requireOwnerOf,
      getEstate: (estate) => service.getEstate(estate),
    }),
    ...createChainDisputes({ send: (ixs) => send(ixs), requireOwnerOf }),

    async getEstate(estate): Promise<EstateSnapshot> {
      const serverMeta = await getMeta(estate);
      const meta = namesKeeper.view(estate, serverMeta);
      // Names are off-chain. Without Supabase the server keeps them in memory only, so after a restart the owner's
      // device shows (and puts back) its own copy; failing that, the owner's wallet label when it is on this device.
      const localOwner = meta && meta.ownerName !== "Estate owner" ? undefined : loadWallets().find((w) => estatePda(chainCtx().programId, w.address).toBase58() === estate)?.label;
      const [raw, events] = await Promise.all([
        fetchEstateRaw(estate, { ...meta, ...(localOwner ? { ownerName: localOwner } : {}) }),
        cached(`activity:${estate}`, 20_000, () => fetchEvents(estate)).catch(() => []),
      ]);
      // A reused slot's line names the rule, so the statement doesn't read the old rule's payments as the new one's.
      const activity = activityFrom(events).map((a, i) => {
        if (a.kind !== "RuleReused") return a;
        const rule = (() => { try { return key(events[i].data, "rule"); } catch { return undefined; } })();
        return rule ? { ...a, reusedRule: rule } : a;
      });
      // The death review's report hash lives in an event (the Estate account keeps only the cert hash): the review of
      // the claim that stands, never of one it replaced.
      const deathHash = deathReviewHash(events, raw.estate.death);
      const hashes = [...new Set([...Object.values(raw.reportHashes), ...(deathHash ? [deathHash] : [])])];
      const reports = hashes.length
        ? await api<Record<string, AgentReport>>(`/api/reports?estate=${estate}&hashes=${hashes.join(",")}`).catch(() => ({} as Record<string, AgentReport>))
        : {};
      const snap = assembleSnapshot(raw, activity, reports);
      const deathReport = deathHash ? reports[deathHash] : undefined;
      const out = deathReport ? { ...snap, estate: { ...snap.estate, death: { ...snap.estate.death, agentReport: deathReport } } } : snap;
      // Guardians: seat and fallback death reviews carry report hashes too (their events).
      const seatHashes = events.filter((e) => ["seatdeathreviewed", "fallbackdeathreviewed"].includes(e.name.toLowerCase()))
        .map((e) => { try { return hex(e.data, "report_hash"); } catch { return ""; } })
        .filter((h) => h && !(h in reports));
      const seatReports = seatHashes.length
        ? await api<Record<string, AgentReport>>(`/api/reports?estate=${estate}&hashes=${[...new Set(seatHashes)].join(",")}`).catch(() => ({} as Record<string, AgentReport>))
        : {};
      // The written reasons of disputes and objections, for members (M9); each one checked against its hash.
      const shared = await cached(`reasons:${estate}:${readerKey()}`, 20_000, () => loadReasons(estate));
      const extras = guardianExtras(meta, { ...reports, ...seatReports }, shared);
      const guardians = await loadGuardians(estate, { estate: out.estate, claims: out.claims, events }, extras).catch(() => disabledGuardians());
      // A successor's display name (the estate meta still holds the original three names).
      const verifierNames = out.estate.verifierNames.map((n, i) => {
        const seat = guardians.seats.find((x) => x.index === i);
        return seat?.holder && seat.generation > 0 ? (extras.names[seat.holder] ?? n) : n;
      }) as [string, string, string];
      // Disputes (U9) and each rule's yearly cap: new accounts, read from the same program scan.
      const [extra, askNotes, residual] = await Promise.all([
        loadDisputes(estate, { estate: out.estate, rules: out.rules }, extras.names, shared).catch(() => ({ disputes: [], rules: out.rules })),
        cached(`asks:${estate}:${readerKey()}`, 15_000, () => asks.loadAsks(estate)).catch(() => ({})),
        residualOf(estate).catch(() => null),
      ]);
      // Names the meta and this device know, for the activity feed (lib/people.ts) and the sale line's buyer.
      const names = extras.names;
      const withBuyers = out.activity.map((a) => (a.sale && !a.sale.buyerName && names[a.sale.buyer] ? { ...a, sale: { ...a.sale, buyerName: names[a.sale.buyer] } } : a));
      const bills = billActivity(estate, out.estate.ownerName);
      const withBills = bills.length ? [...withBuyers, ...bills].sort((a, b) => b.ts - a.ts) : withBuyers;
      // Never waited for, and never a PIN prompt: an unlocked owner's wallet signs quietly or not at all.
      void namesKeeper.sync(estate, serverMeta, {
        estate: out.estate, names, labels: Object.fromEntries(loadWallets().map((w) => [w.address, w.label])),
        people: [out.beneficiaries, out.payees, out.offers, guardians, residual],
      }).then((saved) => { if (saved) forget(`meta:${estate}`); }).catch(() => undefined);
      const me = peekActiveSigner()?.address;
      const signed = me ? signing.get(estate, me) : null;
      return { ...withPrivateNames(out, names), activity: withBills, rules: withChosenEvery(extra.rules, signed?.draft),
        ...(signed?.draft.assets.length ? { plannedAssets: signed.draft.assets } : {}), disputes: extra.disputes, estate: { ...out.estate, verifierNames }, guardians, names, asks: askNotes, residual };
    },

    listEstatesFor(wallet) {
      return cached(`estates:${wallet}`, 60_000, () => listEstatesUncached(wallet));
    },
    getFx: () => api<FxRate>("/api/fx"),

    willChat: (history: WillChatMessage[], locale?: Locale) => post<{ reply: string; draft: WillDraft | null }>("/api/will-chat", { history, locale }),

    async reviewDocument({ file: chosen, purpose, context }) {
      const file = await requireEvidence(chosen);
      const signer = getActiveSigner();
      const estate = estatePda(chainCtx().programId, signer.address).toBase58();
      return (await review(file, purpose, estate, context, undefined, true)).report;
    },

    valueCar: (input) => post<CarValuation>("/api/valuation", input),

    async rankOffers(asset) {
      const raw = await mustFetch("Asset", asset);
      const r = await post<WireRanking>("/api/rank-offers", { estate: key(raw, "estate"), asset });
      return reviveRanking(r);
    },

    // ----- Owner -----
    async createEstateFromWill(input, opts = {}) {
      // The will schema (zod) loads when a plan is signed, not with the service on every first visit.
      const { intervalSecs, willDraftSchema } = await import("../agent/schemas");
      const draft = willDraftSchema.parse(input); // the exact shape the server re-hashes
      const ctx = chainCtx();
      const owner = pk(getActiveSigner().address);
      const { agentAddress } = await api<{ agentAddress: string | null }>("/api/agent");
      if (!agentAddress) throw new Error("The AI agent's wallet is not configured on the server.");

      const estate = estatePda(ctx.programId, owner);
      const exists = await fetchAccountRaw("Estate", estate.toBase58());
      // Everything below is decided before the first transaction: a refusal signs nothing (U2).
      checkPeople(draft, owner.toBase58(), exists ? key(exists, "agent") : agentAddress);
      const willHash = await hashJson(draft);
      const { waitingSecsFor } = await import("../will-summary");
      const waiting = clampDeathWaiting(waitingSecsFor(draft.waitingPeriodDays, "chain"));
      const txs: TxResult[] = [];

      const savedMeta = exists ? await getMetaForWrite(estate.toBase58()) : null;
      const privateNames: Record<Base58, string> = { ...guardianExtras(savedMeta, {}).names };
      const before = exists ? withPrivateNames(await freshEstate(estate.toBase58()), privateNames) : null;
      must(!before || before.estate.status === "Active", "BadStatus", "A plan can only be signed while it is active.");
      const plan = planSetup({
        draft, before, ruleCount: before?.ruleCount ?? 0, practice: !!opts.practice, now: Math.floor(Date.now() / 1000),
        intervalSecs, newWallet: () => Keypair.generate().publicKey.toBase58(),
      });
      const setup: TransactionInstruction[] = [];
      if (!exists) {
        setup.push(ix.createEstate(ctx, {
          owner, agent: pk(agentAddress), verifiers: draft.verifiers.map((v) => pk(v.wallet!)) as [PublicKey, PublicKey, PublicKey],
          deathThreshold: MIN_DEATH_THRESHOLD, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: waiting,
        }));
      }
      setup.push(ix.setWill(ctx, owner, willHash, `heirloom:will:${willHash.slice(0, 16)}`));

      // Names never go on-chain (POPIA): the ledger gets roles, the names stay with the estate's off-chain names.
      const family = new Set(draft.beneficiaries.map((b) => b.wallet!));
      for (const b of draft.beneficiaries) privateNames[b.wallet!] = b.label.slice(0, 64);
      const labelled = before?.beneficiaries.length ?? 0;
      // New family members, and removed ones who are added back (R16).
      setup.push(...plan.beneficiaries.map((b, i) => ix.addBeneficiary(ctx, owner, pk(b.wallet!), publicBeneficiaryLabel(labelled + i))));
      // Practice institutions: fresh addresses on the test network, so every rule has someone to pay.
      for (const p of plan.payees) {
        privateNames[p.wallet] = p.name;
        setup.push(ix.addPayee(ctx, owner, pk(p.wallet), p.kind, publicPayeeName(p, family)));
      }
      for (const { recurring, beneficiary, ...r } of plan.rules) {
        setup.push(ix.addRule(ctx, owner, {
          ...r, beneficiaryWallet: pk(beneficiary),
          recurring: recurring && { amount: recurring.amount, intervalSecs: recurring.intervalSecs, firstDue: recurring.firstDue, payeeWallet: pk(recurring.payee) },
        }));
      }

      const heir = draft.beneficiaries.find((b) => b.label === opts.residualLabel) ?? draft.beneficiaries[0];
      if (heir?.wallet && heir.wallet !== owner.toBase58()) setup.push(ix.setResidual(ctx, owner, pk(heir.wallet)));
      // Before sending (H6): the plan and the names stay on this device, so an interrupted signing is finished from
      // them ("Finish signing") and the names are never lost. The server gets the names as soon as the estate exists.
      rememberOnDevice(privateNames);
      const meta: EstateMeta = {
        estate: estate.toBase58(), ownerWallet: owner.toBase58(), ownerName: draft.ownerName,
        verifierNames: draft.verifiers.map((v) => v.name) as [string, string, string],
        assetTitles: savedMeta?.assetTitles ?? {}, buyerNames: { ...savedMeta?.buyerNames, ...privateNames },
        updatedAt: savedMeta?.updatedAt,
      };
      namesKeeper.remember(meta);
      signing.put(estate.toBase58(), { owner: owner.toBase58(), draft, options: opts, done: false });
      let named = false;
      for (const group of pack(setup)) {
        txs.push(await send(group));
        if (!named) named = await saveMeta(meta, draft).then(() => true, () => false); // names are cosmetic; retried below
      }
      signing.done(estate.toBase58());
      if (!named) await saveMeta(meta, draft).catch(() => undefined);

      // Practice SOL for the people in the plan: a failure here loses nothing (the plan is signed); they can ask for
      // starter funds themselves.
      let topUpFailed = false;

      if (opts.practice) {
        const people = [...new Set([...draft.beneficiaries, ...draft.verifiers].map((p) => p.wallet!))].filter((w) => w !== owner.toBase58());
        const conn = getConnection();
        const held = await Promise.all(people.map((w) => conn.getBalance(pk(w), "confirmed")));
        const top = people.filter((_, i) => held[i] < PRACTICE_SOL_LAMPORTS);
        // Never leave the owner without rent for their own next steps; the sponsor still covers everyone's fees.
        try {
          if (top.length && (await conn.getBalance(owner, "confirmed")) > PRACTICE_SOL_LAMPORTS * (top.length + 1)) {
            for (const group of chunk(top, 6)) {
              txs.push(await send(group.map((w) => SystemProgram.transfer({ fromPubkey: owner, toPubkey: pk(w), lamports: PRACTICE_SOL_LAMPORTS })), { kind: "program" }, { selfPay: true }));
            }
          }
        } catch (e) {
          topUpFailed = true;
          console.warn(`The practice top-up didn't go through: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { estate: estate.toBase58(), txs, ...(topUpFailed ? { topUpFailed } : {}) };
    },

    async unfinishedSigning() {
      const me = peekActiveSigner()?.address;
      if (!me) return null;
      const estate = estatePda(chainCtx().programId, me).toBase58();
      const rec = signing.get(estate, me);
      if (!rec || rec.done) return null;
      const raw = await fetchAccountRaw("Estate", estate).catch(() => undefined);
      if (raw === undefined) return null; // can't tell now: ask again on the next read
      if (!raw) return { draft: rec.draft, options: rec.options };
      // What the plan on-chain still lacks of the signed draft: the will, family members, rules, the named heir.
      const { intervalSecs } = await import("../agent/schemas");
      const before = withPrivateNames(await freshEstate(estate), guardianExtras(namesKeeper.view(estate, await getMeta(estate)), {}).names);
      const willHash = await hashJson(rec.draft);
      const plan = planSetup({
        draft: rec.draft, before, ruleCount: before.ruleCount, practice: !!rec.options.practice, now: Math.floor(Date.now() / 1000), intervalSecs, newWallet: () => me,
      });
      const lacks = before.estate.willHash !== willHash || plan.beneficiaries.length > 0 || plan.rules.length > 0;
      if (!lacks) { signing.done(estate); return null; }
      return { draft: rec.draft, options: rec.options };
    },

    async deposit(estate, amountUsdt) { const o = requireOwnerOf(estate); return send([ix.deposit(chainCtx(), o, toBase(amountUsdt))], { kind: "vault-deposit", to: estate, toLabel: "Estate vault", amount: toBase(amountUsdt).toString() }); },
    async withdraw(estate, amountUsdt) { const o = requireOwnerOf(estate); return send([ix.withdraw(chainCtx(), o, toBase(amountUsdt))], { kind: "program", to: o.toBase58(), toLabel: "Withdrawal", amount: toBase(amountUsdt).toString() }); },
    async heartbeat(estate) { const o = requireOwnerOf(estate); return send([ix.heartbeat(chainCtx(), o)]); },
    async vetoDeath(estate) { const o = requireOwnerOf(estate); return send([ix.vetoDeath(chainCtx(), o)]); },

    async registerAsset(estate, input) {
      const o = requireOwnerOf(estate);
      // Any new asset without a title token gets a fresh one (its own tx: the sponsor does not pay for mints).
      // The registration papers are checked before the title mint is paid for.
      const docFile = input.docFile ? await requireEvidence(input.docFile) : undefined;
      let nftMint = input.nftMint;
      if (!nftMint) {
        const fresh = await newTitleMint(o);
        // The sponsor refuses mints (422), so the owner pays this one without asking it.
        await send(fresh.ixs, { kind: "program" }, { selfPay: true });
        nftMint = fresh.mint.toBase58();
      }
      const docHash = docFile ? await fileHash(docFile) : await sha256Hex(`heirloom:asset:${nftMint}:${input.title}`);
      const tx = await send([ix.registerAsset(chainCtx(), o, {
        nftMint: pk(nftMint), floorPrice: toBase(input.floorUsdt), hardshipFloor: toBase(input.hardshipFloorUsdt),
        askingPrice: toBase(input.askingUsdt), proceedsTo: pk(input.proceedsTo), docHashHex: docHash,
      })]);
      const meta = await getMetaForWrite(estate);
      if (meta) {
        await saveMeta({ ...meta, assetTitles: { ...meta.assetTitles, [nftMint]: input.title } }).catch(() => undefined);
      }
      return tx;
    },

    async addPayee(estate, input) {
      const o = requireOwnerOf(estate);
      const family = new Set((await fetchEstateRaw(estate)).beneficiaries.map((b) => b.wallet));
      const tx = await send([ix.addPayee(chainCtx(), o, pk(input.wallet), input.kind, publicPayeeName(input, family))]);
      // A person's name stays off-chain. A family member keeps the name the family already uses for them.
      if (!family.has(input.wallet)) {
        const name = input.name.trim().slice(0, 64);
        rememberOnDevice({ [input.wallet]: name });
        const meta = await getMetaForWrite(estate);
        if (meta) await saveMeta({ ...meta, buyerNames: { ...meta.buyerNames, [input.wallet]: name } }).catch(() => undefined);
      }
      return tx;
    },


    async requestStarter() {
      const { requestStarterFunds } = await import("../starter/client");
      return requestStarterFunds(getActiveSigner());
    },

    async ownerApproveClaim(estate, claim) {
      const o = requireOwnerOf(estate);
      const raw = await mustFetch("Claim", claim);
      return send([ix.ownerApproveClaim(chainCtx(), o, pk(claim), pk(key(raw, "rule")))]);
    },

    async executeScheduled(estate, rule, shown) {
      // What is paid must be what was shown: read before signing, and again after the wallet signed.
      const check = async () => {
        if (!shown) return;
        const now = await mustFetch("Rule", rule);
        must(key(now, "fixed_payee") === shown.payee && BigInt(String(now.recurring_amount ?? "0")) === shown.amount, "ScheduleChanged",
          "This schedule changed since you looked (its place may hold a new rule). Nothing was paid.");
      };
      await check();
      const raw = await mustFetch("Rule", rule);
      const fixed = key(raw, "fixed_payee");
      return send([ix.executeScheduled(chainCtx(), {
        estate: pk(estate), payer: pk(getActiveSigner().address), rule: pk(rule), beneficiary: pk(key(raw, "beneficiary")), payeeWallet: pk(fixed),
      })],
        { kind: "scheduled", to: fixed, toLabel: "Scheduled payee", amount: String(raw.recurring_amount ?? "0") }, { check: () => { invalidateProgramAccounts(); return check(); } });
    },

    // ----- Family -----
    async submitDeathClaim(estate, chosen) {
      const certificate = await requireEvidence(chosen);
      const me = pk(getActiveSigner().address);
      const h = await fileHash(certificate);
      const raw = await mustFetch("Estate", estate);
      const step = deathClaimStep(raw, me.toBase58(), h, Math.floor(Date.now() / 1000));
      const tx = step === "send" ? await send([ix.submitDeathClaim(chainCtx(), pk(estate), me, h, await deathReporter(estate, raw, me.toBase58()))]) : null;
      const meta = await getMeta(estate);
      const r = await review(certificate, "death", estate, `Estate owner's name: ${meta?.ownerName ?? "unknown"}.`);
      return { tx: (tx ?? r.tx)!, report: r.report };
    },

    async submitClaim(estate, chosen) {
      const input = { ...chosen, evidence: await requireEvidence(chosen.evidence) };
      const ctx = chainCtx();
      const me = pk(getActiveSigner().address);
      const rule = await mustFetch("Rule", input.rule);
      const ruleId = num(rule, "id");
      const claimId = num(rule, "claim_count");
      const h = await fileHash(input.evidence);
      const tx = await send([ix.submitClaim(ctx, {
        estate: pk(estate), signer: me, ruleId, claimId, payeeWallet: pk(input.payee), amount: toBase(input.amountUsdt), evidenceHashHex: h,
      })]);
      const claim = claimPda(ctx.programId, input.rule, claimId).toBase58();
      // Sent: a review that doesn't finish leaves the claim waiting for it, to be asked for again (H7).
      const r = await review(input.evidence, "claim", estate, `Claim for ${input.amountUsdt} USD₮ under rule #${ruleId}, payee wallet ${input.payee}.`, claim)
        .catch((e: unknown) => { throw reviewPending(e); });
      return { tx, claim, report: r.report, reviewTx: r.tx };
    },

    async submitHardship(estate, chosen) {
      const input = { ...chosen, evidence: await requireEvidence(chosen.evidence) };
      const ctx = chainCtx();
      const me = pk(getActiveSigner().address);
      const h = await fileHash(input.evidence);
      const tx = await send([ix.submitHardship(ctx, pk(estate), pk(input.asset), me, h)]);
      const hardship = hardshipPda(ctx.programId, input.asset, me).toBase58();
      const r = await review(input.evidence, "hardship", estate, "Hardship request to sell the car below the floor price.", hardship)
        .catch((e: unknown) => { throw reviewPending(e); });
      return { tx, report: r.report };
    },

    async requestReview(estate, { kind, subject, evidence }) {
      const raw = await mustFetch(kind === "claim" ? "Claim" : "Hardship", subject);
      const me = getActiveSigner().address;
      must(key(raw, "beneficiary") === me, "forbidden", "Only the person who sent this can ask for its review.");
      must(enumOf(raw, "agent_verdict", ["Pending", "Approved", "Rejected", "Referred"] as const) === "Pending", "already_reviewed", "The agent has already reviewed this.");
      const file = evidence ? await requireEvidence(evidence) : kind === "claim" ? await asks.noteFileFor(estate, subject) : null;
      must(file && await fileHash(file) === hex(raw, "evidence_hash"), "hash_mismatch", "This isn't the file that was sent. Choose that same file.");
      const context = kind === "claim"
        ? `Claim for ${fromBase(BigInt(String(raw.amount)))} USD₮, payee wallet ${key(raw, "payee")}. The review is asked for again after the first did not finish.`
        : "Hardship request to sell the car below the floor price. The review is asked for again after the first did not finish.";
      const r = await review(file, kind, estate, context, subject).finally(written);
      return { tx: r.tx, report: r.report };
    },

    // ----- Verifiers -----
    async attestDeath(estate) { return send([ix.attestDeath(pk(estate), pk(getActiveSigner().address))]); },

    async approveClaim(estate, claim) {
      const raw = await mustFetch("Claim", claim);
      const verifier = pk(getActiveSigner().address);
      // The owner's "no" while alive is off-chain (lib/ask); a trusted person never approves past it (H9).
      if (raw.owner_approved !== true) {
        await ensureReadPass(getActiveSigner());
        must(!(await asks.loadAsks(estate, { strict: true }))[claim]?.declinedAt, "Declined", "The owner said no to this request while alive.");
      }
      return sendStampPaid(verifier, () => ix.approveClaim(pk(estate), verifier, pk(claim), pk(key(raw, "rule"))));
    },

    async approveHardship(estate, hardship) {
      const raw = await mustFetch("Hardship", hardship);
      const standing = optKey(await mustFetch("Asset", key(raw, "asset")), "hardship_beneficiary");
      if (standing && standing !== key(raw, "beneficiary")) {
        throw new ChainServiceError("BadStatus", "Another person's approved hardship stands on this asset. It has to be objected to, and upheld, first.");
      }
      const verifier = pk(getActiveSigner().address);
      return sendStampPaid(verifier, () => ix.approveHardship(pk(estate), verifier, pk(key(raw, "asset")), pk(hardship)));
    },

    // ----- Anyone -----
    async finalizeUnlock(estate) { return send([ix.finalizeUnlock(pk(estate), pk(getActiveSigner().address))]); },

    async executeClaim(estate, claim) {
      const raw = await mustFetch("Claim", claim);
      // The owner's "no" is kept by Heirloom, not by the contract: read strictly, so nothing pays when it can't be read (N8).
      if (raw.owner_approved !== true) {
        await ensureReadPass(getActiveSigner());
        must(!(await asks.loadAsks(estate, { strict: true }))[claim]?.declinedAt, "Declined", "The owner said no to this request while alive.");
      }
      return send([ix.executeClaim(chainCtx(), {
        estate: pk(estate), payer: pk(getActiveSigner().address), rule: pk(key(raw, "rule")), claim: pk(claim),
        beneficiary: pk(key(raw, "beneficiary")), payeeWallet: pk(key(raw, "payee")),
      })], { kind: "claim-payout", to: key(raw, "payee"), toLabel: "Approved institution", amount: String(raw.amount ?? "0") });
    },

    // ----- P2P USD₮ (Tether track flow: review → approve → WDK sign → pending → confirmed) -----
    async reviewSend({ to, toLabel, amountUsdt, bill: billInput, selfPay = false }): Promise<PaymentReview> {
      const from = getActiveSigner().address;
      const bill = billInput ? (await billSchemas()).billDetailsSchema.parse(billInput) : undefined;
      let toKey: PublicKey;
      try { toKey = pk(to); } catch { throw new Error("That is not a valid Solana address."); }
      if (to === from) throw new Error("You cannot send to your own wallet.");
      if (!(amountUsdt > 0)) throw new Error("Enter an amount above zero.");
      const amount = toBase(amountUsdt);
      await refuseIfStillChecking({ kind: bill ? "bill" : "p2p", to, amount: amount.toString(), from });
      const conn = getConnection();
      const mint = chainCtx().usdtMint;
      const warnings: string[] = [];

      // Token check: the configured USD₮ mint must exist on this cluster with 6 decimals.
      const mintInfo = await conn.getParsedAccountInfo(mint, "confirmed");
      const parsed = mintInfo.value?.data as { parsed?: { type?: string; info?: { decimals?: number } } } | undefined;
      const verified = parsed?.parsed?.type === "mint" && parsed.parsed.info?.decimals === 6;
      if (!verified) warnings.push("The USD₮ token could not be verified on this network. Do not send.");
      if (!PublicKey.isOnCurve(toKey.toBytes())) warnings.push("This address is a program account, not a person's wallet. Check it carefully.");

      // Balances + fee quote via Tether WDK (read-only account: no keys needed).
      const ro = await readOnly(from, chainConfig.rpcUrl);
      const [usdt, lamports, quote, recipientAta] = await Promise.all([
        ro.getTokenBalance(mint.toBase58()), ro.getBalance(),
        ro.quoteTransfer({ token: mint.toBase58(), recipient: to, amount }).catch(() => null),
        conn.getAccountInfo(ata(mint, toKey), "confirmed"),
      ]);
      // Rent for a new token account, as the network asks for it now (M3).
      const rent = recipientAta ? 0 : await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, "confirmed");
      const networkFee = Number(quote?.fee ?? 5000n);
      // A sponsored review only when the sponsor can co-sign for this wallet; asked to, the user pays.
      const status = selfPay || !getActiveSigner().signPartial ? null : await sponsorClient.status().catch(() => null);
      const sponsor = status?.feePayer === from ? null : status;
      // Sponsored: two signatures (sponsor + sender) instead of one.
      const { fee, userLamports } = feeForReview({ user: from, networkFeeLamports: sponsor?.available ? 10_000 : networkFee, rentLamports: rent, sponsor });
      if (!recipientAta) {
        warnings.push(fee.sponsored && sponsor?.paysRent
          ? "The recipient has no USD₮ account yet: it will be created, and Heirloom covers the cost."
          : "The recipient has no USD₮ account yet: it will be created (about 0.002 SOL, paid by you).");
      }
      if (!quote && !fee.sponsored) warnings.push("Fee estimate unavailable; using the standard network fee.");
      const sol = Number(lamports) / 1e9;
      const sufficient = usdt >= amount && Number(lamports) >= userLamports;
      if (usdt < amount) warnings.push("Not enough USD₮ in this wallet.");
      if (Number(lamports) < userLamports) warnings.push("Not enough SOL to pay the network fee.");

      const review: PaymentReview = {
        id: newPaymentId(), kind: bill ? "bill" : "p2p", from, to, toLabel: toLabel || bill?.payee || "", amount,
        token: { symbol: "USD₮", mint: mint.toBase58(), verified },
        network: { name: `Solana ${chainConfig.cluster}`, cluster: chainConfig.cluster === "mainnet-beta" ? "mainnet-beta" : chainConfig.cluster === "localnet" ? "localnet" : "devnet" },
        fee: { ...fee, networkLamports: fee.sponsored ? (sponsor?.available ? 10_000 : networkFee) : networkFee, rentLamports: rent, ...(rent ? { rentPayer: fee.sponsored && sponsor?.paysRent ? fee.payer : from } : {}) },
        balances: { usdt, sol, sufficient },
        warnings,
        ...(bill ? { bill } : {}),
      };
      receipts.put({ id: review.id, status: "awaiting-approval", kind: review.kind, from, to, toLabel: review.toLabel, amount: amount.toString(), updatedAt: Date.now(), ...(bill ? { bill } : {}) });
      return review;
    },

    async confirmSend(review) {
      if (!review.token.verified) throw new Error("The USD₮ token is not verified on this network; payment blocked.");
      if (review.token.mint !== chainCtx().usdtMint.toBase58()) throw new Error("Token mismatch: this is not the configured USD₮ mint.");
      if (review.from !== getActiveSigner().address) throw new Error("Switch back to the wallet that reviewed this payment.");
      const mint = chainCtx().usdtMint;
      const from = pk(review.from), to = pk(review.to);
      const needsAta = !(await getConnection().getAccountInfo(ata(mint, to), "confirmed"));
      // An account to create that the review didn't show: the cost changed, so it is shown again first.
      if (needsAta && review.fee.rentLamports === 0) throw new ChainServiceError("FeeChanged", "The recipient's USD₮ account was closed since you looked, so it costs rent again. Nothing was signed.");
      const sponsorPaysRent = review.fee.sponsored && Boolean((await sponsorClient.status().catch(() => null))?.paysRent);
      // The rent payer for a new recipient account is the sponsor when it is the fee payer and covers rent.
      const ixs = (feePayer: PublicKey) => [
        ...(needsAta ? [createAssociatedTokenAccountIdempotentInstruction(!feePayer.equals(from) && sponsorPaysRent ? feePayer : from, ata(mint, to), to, mint)] : []),
        createTransferCheckedInstruction(ata(mint, from), mint, ata(mint, to), from, review.amount, 6),
      ];
      const bill = review.bill ? (await billSchemas()).billDetailsSchema.parse(review.bill) : undefined;
      return withFee(review.fee, () => pay(review.id, ixs, { kind: bill ? "bill" : "p2p", from: review.from, to: review.to, toLabel: review.toLabel, amount: review.amount.toString(), ...(bill ? { bill } : {}) }, !review.fee.sponsored));
    },

    getReceipt: (id): Promise<PaymentReceipt | null> => recheck(receipts, chainOps(), id),

    withShownFee: (fee, work) => withFee(fee, work),

    async quoteFee(estate, q) {
      const me = getActiveSigner().address;
      const conn = getConnection();
      const ctx = chainCtx();
      const status = q.selfPay || !getActiveSigner().signPartial ? null : await sponsorClient.status().catch(() => null);
      const sponsored = !!status?.available && !!status.feePayer && status.feePayer !== me;
      const txs = 1 + (q.approve ? 1 : 0);
      const exists = async (k: PublicKey) => !!(await conn.getAccountInfo(k, "confirmed"));
      const rentOf = (bytes: number) => conn.getMinimumBalanceForRentExemption(bytes, "confirmed");
      let userRent = 0;
      let sponsorRent = 0;
      // Accounts this payment creates, and who pays their rent (the program's payer, or the sponsor where it may).
      if ((q.kind === "claim-payout" || q.kind === "scheduled") && !(await exists(ata(ctx.usdtMint, pk(q.to))))) userRent += await rentOf(TOKEN_ACCOUNT_SIZE);
      if (q.kind === "offer" && !(await exists(offerPda(ctx.programId, q.to, me)))) userRent += (await rentOf(OFFER_SIZE)) + (await rentOf(TOKEN_ACCOUNT_SIZE));
      if (q.approve === "verifier" && q.claim && !(await exists(stampPda(ctx.programId, q.claim)))) {
        const stamp = await rentOf(STAMP_SIZE);
        if (sponsored && status?.paysRent) sponsorRent += stamp; else userRent += stamp;
      }
      const network = sponsored ? 10_000 * txs : 5_000 * txs;
      const payer = sponsored ? status!.feePayer! : me;
      const lamports = network + (sponsored ? sponsorRent : userRent);
      const rent = userRent + sponsorRent;
      return {
        fee: { lamports, sol: lamports / 1e9, payer, sponsored, networkLamports: network, rentLamports: rent, ...(rent ? { rentPayer: userRent ? me : payer } : {}) },
        userLamports: (sponsored ? 0 : network) + userRent,
        solBalance: (await conn.getBalance(pk(me), "confirmed")) / 1e9,
      };
    },

    async listPendingReceipts() {
      const out: PaymentReceipt[] = [];
      for (const r of openReceipts(receipts)) { const n = await recheck(receipts, chainOps(), r.id).catch(() => r); if (n) out.push(n); }
      return out;
    },

    async savedRecipients(estate?: Base58): Promise<SavedRecipient[]> {
      const me = getActiveSigner().address;
      // The estate on screen first (its family and trusted people by name), then this device's wallets, then people
      // paid before.
      const people = estate ? await service.getEstate(estate).then((s) => estateRecipients(s, me)).catch(() => []) : [];
      const devices = loadWallets().filter((w) => w.address !== me).map((w) => ({ label: w.label, address: w.address, relationship: w.role }));
      const paid = receipts.list().filter((r) => r.kind === "p2p" && r.to && r.toLabel && r.to !== me).map((r) => ({ label: r.toLabel!, address: r.to! }));
      return mergeRecipients(people, devices, paid);
    },

    // ----- Pay a bill once: same WDK transfer as a send, with the bill's details on the receipt -----
    async billPayees() { return (await billBook()).list(getActiveSigner().address); },
    async saveBillPayee(input) { return (await billBook()).save(getActiveSigner().address, input); },
    async readInvoice(chosen): Promise<InvoiceRead> {
      const file = await requireEvidence(chosen);
      const form = new FormData();
      form.set("file", file);
      const { invoiceReadSchema } = await import("../bills/invoice");
      return invoiceReadSchema.parse(await api<unknown>("/api/invoice", { method: "POST", body: form }));
    },
    async paidBills() {
      const me = getActiveSigner().address;
      // Re-check open ones first (never re-sends), so a bill confirmed while away shows as paid.
      for (const b of billsFrom(me)) if (["signing", "submitted", "pending"].includes(b.status)) await recheck(receipts, chainOps(), b.id).catch(() => null);
      return billsFrom(me).filter((b) => b.status !== "awaiting-approval");
    },

    // ----- Car sale -----
    async listAsset(estate, asset, durationSecs) {
      const snap = await freshEstate(estate); // who holds a seat decides who may ask
      must(mayAskToList(snap.estate.verifiers, snap.beneficiaries, getActiveSigner().address, snap.assets.find((a) => a.address === asset), snap.offers),
        "NotVerifier", "Only a trusted person can open the sale. Family can, when no trusted person is left, for an asset not yet listed or a listing that ended without an acceptable offer.");
      return signedPost<TxResult>("/api/list-asset", "list-asset", estate, { estate, asset, durationSecs }, actionBody.listAsset({ asset, durationSecs }))
        .finally(written);
    },

    async placeOffer(estate, asset, amountUsdt, buyerName) {
      const me = pk(getActiveSigner().address);
      const ctx = chainCtx();
      // Changing an offer: place_offer creates the Offer account, so the old one is withdrawn first, in the same
      // transaction (H13). Both or neither: the escrow never sits empty between them.
      const existing = await getConnection().getAccountInfo(offerPda(ctx.programId, asset, me.toBase58()), "confirmed");
      const tx = await send([
        ...(existing ? [ix.withdrawOffer(ctx, pk(estate), pk(asset), me)] : []),
        ix.placeOffer(ctx, pk(estate), pk(asset), me, toBase(amountUsdt)),
      ],
        { kind: "offer", to: asset, toLabel: "Offer escrow", amount: toBase(amountUsdt).toString() });
      // The buyer's own name beside the offer and on the sale (off-chain; never replaces a name the owner gave).
      const name = buyerName?.trim().slice(0, 64);
      if (name && getActiveSigner().canSignQuietly?.() !== false) {
        await post("/api/estate-meta", await signedMetaRequest(getActiveSigner(), "buyer-name", estate, { asset, name }))
          .then(() => forget(`meta:${estate}`)).catch(() => undefined);
      }
      return tx;
    },

    async withdrawOffer(estate, asset) {
      const me = getActiveSigner().address;
      if (!(await fetchAccountRaw("Offer", offerPda(chainCtx().programId, asset, me).toBase58()))) throw new Error("You have no open offer on this car.");
      return send([ix.withdrawOffer(chainCtx(), pk(estate), pk(asset), pk(me))]);
    },

    acceptBestOffer: (estate, asset, seen) => acceptBestOffer({
      fetchEstate: freshEstate,
      latestBlockhash: async () => (await getConnection().getLatestBlockhash("confirmed")).blockhash,
      saleTiming: (e, a) => loadSaleTiming(e, a),
      headers: (e, body) => actionHeaders(getActiveSigner(), "accept-offer", e, body),
    }, estate, asset, seen).finally(written),

    legacyStatus: (estate, opts) => legacyApi.status(legacySigner(estate), opts),
    createLegacyVoice: (estate, input) => legacyApi.createVoice(legacySigner(estate), input),
    deleteLegacyVoice: (estate) => legacyApi.deleteVoice(legacySigner(estate)),
    saveLegacyBook: (estate, book) => legacyApi.saveBook(legacySigner(estate), book),
    deleteLegacyBook: (estate) => legacyApi.deleteBook(legacySigner(estate)),
    setLegacyOptIn: (estate, on) => legacyApi.optIn(legacySigner(estate), on),
    legacySpeak: (estate, input) => legacyApi.speak(legacySigner(estate), input),
    saveLegacyTranslation: (estate, input) => legacyApi.saveTranslation(legacySigner(estate), input),
    deleteLegacyTranslation: (estate, key) => legacyApi.deleteTranslation(legacySigner(estate), key),
    suggestLegacyTranslation: (estate, key) => legacyApi.suggestTranslation(legacySigner(estate), key),
  };
  return service;
}
