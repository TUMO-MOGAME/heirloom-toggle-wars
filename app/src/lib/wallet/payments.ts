/**
 * Pay-once payment pipeline (Tether track flow): review → approve → WDK signs → we persist the signature →
 * broadcast → receipt "pending" until confirmed.
 *
 * Why we sign first and broadcast ourselves: a Solana signature is known as soon as the tx is signed. We store
 * it (plus the signed bytes and the blockhash expiry) in localStorage BEFORE broadcasting, so after a dropped
 * connection or a reload we re-check that same signature and, if needed, re-broadcast the same signed bytes.
 * Re-broadcasting identical bytes can never pay twice; once the blockhash expires the tx can never land, so
 * only then do we declare it "not paid, safe to retry". A payment id with a signature is never re-signed.
 * Pure logic with injectable storage/chain ops, so it is unit-tested (payments.test.ts).
 */
import type { PaymentReceipt, PaymentReview, PaymentStatus } from "../types";
import { explorerTx } from "../format";

export interface StoredPayment extends PaymentReceipt {
  kind?: PaymentReview["kind"];
  to?: string;
  toLabel?: string;
  amount?: string; // base units as string (JSON-safe)
  /** kind "bill": the paying wallet and the bill's details (payee, reference, invoice hash), for the receipts list. */
  from?: string;
  bill?: PaymentReview["bill"];
  wireBase64?: string;
  lastValidBlockHeight?: number;
  /** Fee payer of the signed tx; `sponsored` = Heirloom's sponsor wallet paid the network fee. */
  feePayer?: string;
  sponsored?: boolean;
}

export interface ReceiptStore {
  get(id: string): StoredPayment | null;
  put(p: StoredPayment): void;
  list(): StoredPayment[];
}

export interface SignedTx { signature: string; wireBase64: string; lastValidBlockHeight: number; feePayer?: string; sponsored?: boolean }

export interface ChainOps {
  /** null = the cluster does not know this signature (yet). */
  status(signature: string): Promise<{ err: unknown; confirmationStatus?: string | null; confirmations?: number | null } | null>;
  blockHeight(): Promise<number>;
  broadcast(wireBase64: string): Promise<void>;
}

const OPEN: PaymentStatus[] = ["signing", "submitted", "pending"];

export function newPaymentId(): string {
  return `pay_${Date.now().toString(36)}_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------- stores ----------
const KEY = "heirloom.payments.v1";

export function localReceiptStore(): ReceiptStore {
  // What storage refused to keep (full, or blocked mid-visit): a stored signature must never be forgotten in this tab.
  const unsaved = new Map<string, StoredPayment>();
  const read = (): Record<string, StoredPayment> => {
    let all: Record<string, StoredPayment> = {};
    try { all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, StoredPayment>; } catch { /* unreadable */ }
    for (const [id, p] of unsaved) if (!all[id] || all[id].updatedAt < p.updatedAt) all[id] = p;
    return all;
  };
  const write = (all: Record<string, StoredPayment>) => {
    // Keep the newest 100 receipts, and every one still open.
    const entries = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt).filter((e, i) => i < 100 || OPEN.includes(e.status));
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, e]))));
      unsaved.clear();
    } catch { for (const e of entries) unsaved.set(e.id, e); }
  };
  return {
    get: (id) => read()[id] ?? null,
    put: (p) => { const all = read(); all[p.id] = p; write(all); },
    list: () => Object.values(read()).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export function memoryReceiptStore(): ReceiptStore {
  const m = new Map<string, StoredPayment>();
  return { get: (id) => m.get(id) ?? null, put: (p) => { m.set(p.id, { ...p }); }, list: () => [...m.values()] };
}

/** Browser default: localStorage when available, else memory (private mode). */
export function defaultReceiptStore(): ReceiptStore {
  try { localStorage.getItem(KEY); return localReceiptStore(); } catch { return memoryReceiptStore(); }
}

// ---------- pipeline ----------
const publicReceipt = (p: StoredPayment): PaymentReceipt => ({
  id: p.id, status: p.status, signature: p.signature, explorerUrl: p.explorerUrl, confirmations: p.confirmations, error: p.error, updatedAt: p.updatedAt,
  ...(p.code ? { code: p.code } : {}),
});

/** Open payments of this kind, to this address, for this amount: the same payment, still being checked. */
export function sameOpen(store: ReceiptStore, meta: Pick<StoredPayment, "kind" | "to" | "amount" | "from">): StoredPayment[] {
  return store.list().filter((p) => OPEN.includes(p.status) && !!p.signature && p.kind === meta.kind && p.to === meta.to
    && p.amount === meta.amount && (!meta.from || !p.from || p.from === meta.from));
}

function save(store: ReceiptStore, p: StoredPayment, patch: Partial<StoredPayment>): StoredPayment {
  const next = { ...p, ...patch, updatedAt: Date.now() };
  store.put(next);
  return next;
}

/**
 * True when an RPC error means the tx was rejected before it could ever land (preflight/simulation). Never when the
 * network says it has the transaction already, or did not know the blockhash yet: those bytes may still land.
 */
export function isDefinitiveRejection(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/already (?:been )?processed|AlreadyProcessed|blockhash not found|BlockhashNotFound|timed? ?out|fetch failed|network/i.test(msg)) return false;
  return /simulation failed|preflight|custom program error|insufficient|Error Code:|InstructionError|0x1\b/i.test(msg);
}

/** Signs in progress in this tab, by store and payment id (M8: two confirms of one id never sign twice). */
const inFlight = new WeakMap<ReceiptStore, Map<string, Promise<PaymentReceipt>>>();
const flights = (store: ReceiptStore) => { let m = inFlight.get(store); if (!m) inFlight.set(store, (m = new Map())); return m; };

/** Confirmed or finalized: the network's last word. A failure seen only at "processed" can still be forked away. */
const settled = (st: { confirmationStatus?: string | null }) => st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized";

/**
 * Re-checks a stored payment. Never signs. May re-broadcast the SAME signed bytes while the blockhash is valid.
 */
export async function recheck(store: ReceiptStore, ops: ChainOps, id: string): Promise<PaymentReceipt | null> {
  const p = store.get(id);
  if (!p) return null;
  // Still signing in this tab: not interrupted, just waiting for the wallet.
  if (p.status === "signing" && !p.signature && flights(store).has(id)) return publicReceipt(p);
  if (!p.signature || !OPEN.includes(p.status)) {
    // "signing" without a signature = the app closed before WDK produced one: nothing was broadcast.
    if (p.status === "signing" && !p.signature) {
      return publicReceipt(save(store, p, { status: "failed", error: "Signing was interrupted before anything was sent. Nothing was paid; you can try again." }));
    }
    return publicReceipt(p);
  }
  // Once a signature is stored this never throws: an RPC error means "still checking", never "nothing was paid" (H8).
  // The height is read before the status, so "expired" is only said of a transaction that was still unknown after
  // its blockhash had run out.
  const height = await ops.blockHeight().catch(() => null);
  let st: Awaited<ReturnType<ChainOps["status"]>>;
  try { st = await ops.status(p.signature); } catch { return publicReceipt(p); }
  if (st?.err && (settled(st) || !st.confirmationStatus)) {
    return publicReceipt(save(store, p, { status: "failed", error: `The network rejected this payment (${JSON.stringify(st.err)}). Its USD₮ did not move.` }));
  }
  if (st && settled(st)) {
    return publicReceipt(save(store, p, { status: "confirmed", confirmations: st.confirmations ?? undefined, error: undefined }));
  }
  if (st) return publicReceipt(save(store, p, { status: "pending", confirmations: st.confirmations ?? 0 }));

  // Unknown to the cluster: still landable while the blockhash is valid → re-broadcast the same bytes.
  if (height !== null && p.lastValidBlockHeight !== undefined && height > p.lastValidBlockHeight) {
    return publicReceipt(save(store, p, { status: "failed", error: "This payment expired before it reached the network. Nothing was paid; it is safe to try again." }));
  }
  if (p.wireBase64) await ops.broadcast(p.wireBase64).catch(() => undefined);
  return publicReceipt(save(store, p, { status: "pending" }));
}

/**
 * Runs a payment once. If this id already has a signature, it only re-checks (never re-signs, never pays twice).
 */
export async function runPayment(
  store: ReceiptStore, ops: ChainOps, id: string, sign: () => Promise<SignedTx>,
  meta: Pick<StoredPayment, "kind" | "to" | "toLabel" | "amount" | "from" | "bill"> = {},
): Promise<PaymentReceipt> {
  const running = flights(store).get(id);
  if (running) return running;
  const run = runOnce(store, ops, id, sign, meta);
  flights(store).set(id, run);
  try { return await run; } finally { flights(store).delete(id); }
}

async function runOnce(
  store: ReceiptStore, ops: ChainOps, id: string, sign: () => Promise<SignedTx>,
  meta: Pick<StoredPayment, "kind" | "to" | "toLabel" | "amount" | "from" | "bill">,
): Promise<PaymentReceipt> {
  const existing = store.get(id);
  if (existing?.signature) return (await recheck(store, ops, id))!;
  if (existing && (existing.status === "confirmed" || existing.status === "cancelled")) return publicReceipt(existing);

  let p = save(store, existing ?? { id, status: "signing", updatedAt: Date.now() }, { ...meta, status: "signing", error: undefined, code: undefined });
  let signed: SignedTx;
  try {
    signed = await sign();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return publicReceipt(save(store, p, {
      status: "failed", error: `Not signed: ${e instanceof Error ? e.message : String(e)}. Nothing was paid.`, ...(typeof code === "string" ? { code } : {}),
    }));
  }
  // Persist BEFORE broadcasting: from here on, this id is bound to this signature.
  p = save(store, p, {
    status: "submitted", signature: signed.signature, explorerUrl: explorerTx(signed.signature),
    wireBase64: signed.wireBase64, lastValidBlockHeight: signed.lastValidBlockHeight,
    feePayer: signed.feePayer, sponsored: signed.sponsored,
  });
  try {
    await ops.broadcast(signed.wireBase64);
  } catch (e) {
    if (isDefinitiveRejection(e)) {
      return publicReceipt(save(store, p, { status: "failed", error: `${e instanceof Error ? e.message : String(e)}. Nothing was paid.` }));
    }
    // Network trouble: keep "submitted"; recheck() on reconnect decides.
    return publicReceipt(save(store, p, { error: "Connection problem while sending. We will re-check this payment automatically; do not pay again." }));
  }
  return (await recheck(store, ops, id)) ?? publicReceipt(p);
}

export function cancelPayment(store: ReceiptStore, id: string): PaymentReceipt | null {
  const p = store.get(id);
  if (!p) { const c: StoredPayment = { id, status: "cancelled", updatedAt: Date.now() }; store.put(c); return publicReceipt(c); }
  if (p.signature) return publicReceipt(p); // too late to cancel: it may already be on its way
  return publicReceipt(save(store, p, { status: "cancelled" }));
}

/** Polls until confirmed/failed or timeout; returns the last receipt. */
export async function waitForFinal(store: ReceiptStore, ops: ChainOps, id: string, timeoutMs = 60_000, everyMs = 1_000): Promise<PaymentReceipt | null> {
  const end = Date.now() + timeoutMs;
  let r = await recheck(store, ops, id);
  while (r && OPEN.includes(r.status) && Date.now() < end) {
    await new Promise((res) => setTimeout(res, everyMs));
    r = await recheck(store, ops, id);
  }
  return r;
}

export function openReceipts(store: ReceiptStore): PaymentReceipt[] {
  return store.list().filter((p) => OPEN.includes(p.status)).map(publicReceipt);
}

/** Re-checks every open payment now and whenever the browser comes back online or the tab becomes visible. */
export function resumeOnReconnect(store: ReceiptStore, ops: ChainOps, onUpdate?: (r: PaymentReceipt) => void): () => void {
  const run = async () => {
    for (const r of openReceipts(store)) {
      const next = await recheck(store, ops, r.id).catch(() => null);
      if (next) onUpdate?.(next);
    }
  };
  void run();
  if (typeof window === "undefined") return () => undefined;
  const vis = () => { if (document.visibilityState === "visible") void run(); };
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", vis);
  return () => { window.removeEventListener("online", run); document.removeEventListener("visibilitychange", vis); };
}

// ---------- fee sponsorship (families do not need SOL) ----------

export interface SponsorStatus { available: boolean; feePayer: string | null; maxFeeLamports: number; paysRent: boolean }

export class SponsorError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "SponsorError"; }
  /** The sponsor refused for a reason that also applies if the user pays (the program would reject the tx). */
  get fatal(): boolean { return this.code === "simulation_failed"; }
}

export interface SponsorClient {
  status(): Promise<SponsorStatus | null>;
  /** Server validates + co-signs as fee payer; never broadcasts (submit=false), so the caller can persist first. */
  cosign(partialWireBase64: string): Promise<{ signature: string; wireBase64: string }>;
}

export interface SponsoredSignDeps {
  user: string;
  /** Builds the unsigned base64 tx with the given fee payer (fresh blockhash). */
  build(feePayer: string): Promise<{ base64: string; lastValidBlockHeight: number }>;
  /** User's WDK partial signature (fee payer = someone else). Absent → user pays. */
  signPartial?: (base64: string) => Promise<{ wireBase64: string }>;
  /** User's WDK signature as fee payer (fallback). */
  signOnly(base64: string): Promise<{ signature: string; wireBase64: string }>;
  sponsor?: SponsorClient | null;
  onFallback?: (reason: string) => void;
  /**
   * The review said Heirloom pays the fee (M3): if the sponsor can't now, nothing is signed for the user to pay
   * silently. It fails with code "FeeChanged", and the screen shows the cost again before the user pays it.
   */
  requireSponsor?: boolean;
}

/**
 * Signs with the sponsor as fee payer when it is available, else the user pays. Falling back is safe for
 * pay-once: the sponsor never broadcasts, so a co-signed tx whose response was lost can never land.
 * A simulation failure is not retried as user-paid (the program would reject it either way).
 */
export async function signSponsoredOrSelf(d: SponsoredSignDeps): Promise<SignedTx> {
  const st = d.sponsor && d.signPartial ? await d.sponsor.status().catch(() => null) : null;
  if (st?.available && st.feePayer && st.feePayer !== d.user && d.signPartial && d.sponsor) {
    try {
      const { base64, lastValidBlockHeight } = await d.build(st.feePayer);
      const partial = await d.signPartial(base64);
      const full = await d.sponsor.cosign(partial.wireBase64);
      return { signature: full.signature, wireBase64: full.wireBase64, lastValidBlockHeight, feePayer: st.feePayer, sponsored: true };
    } catch (e) {
      if (e instanceof SponsorError && e.fatal) throw e;
      if (d.requireSponsor) throw feeChanged(e instanceof Error ? e.message : String(e));
      d.onFallback?.(e instanceof Error ? e.message : String(e));
    }
  }
  if (d.requireSponsor) throw feeChanged("the fee sponsor is not available");
  const { base64, lastValidBlockHeight } = await d.build(d.user);
  return { ...(await d.signOnly(base64)), lastValidBlockHeight, feePayer: d.user, sponsored: false };
}

const feeChanged = (why: string) => Object.assign(new SponsorError("FeeChanged", `FeeChanged: Heirloom can't pay this fee now (${why}). Nothing was signed.`), { code: "FeeChanged" });

/** Fee shown on the review screen: sponsored → the sponsor pays fee (and rent when it covers rent). */
export function feeForReview(opts: { user: string; networkFeeLamports: number; rentLamports: number; sponsor: SponsorStatus | null }) {
  const s = opts.sponsor;
  if (s?.available && s.feePayer && opts.networkFeeLamports <= s.maxFeeLamports) {
    const userLamports = s.paysRent ? 0 : opts.rentLamports;
    const lamports = opts.networkFeeLamports + (s.paysRent ? opts.rentLamports : 0);
    return { fee: { lamports, sol: lamports / 1e9, payer: s.feePayer, sponsored: true }, userLamports };
  }
  const lamports = opts.networkFeeLamports + opts.rentLamports;
  return { fee: { lamports, sol: lamports / 1e9, payer: opts.user, sponsored: false }, userLamports: lamports };
}
