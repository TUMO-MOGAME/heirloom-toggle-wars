"use client";
/**
 * The one payment flow, used everywhere USD₮ moves:
 * Review (recipient, amount in USD₮ and ZAR, network, fee, verified token, balance, warnings)
 * → Approve / Cancel → "Signing with your Tether wallet (WDK)" → Pending until confirmed → Confirmed + Explorer link.
 * Pending P2P payments are remembered on the device and re-checked (never re-sent) after a reload or reconnect.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { BadgeCheck, Check, CircleAlert, Loader2, RefreshCw, ShieldAlert, WifiOff } from "@/components/ui/icons";
import type { HeirloomService } from "@/lib/service";
import type { PaymentReview } from "@/lib/types";
import type { SponsorStatus } from "@/lib/wallet/payments";
import { formatUsdt, formatUsdtExact, formatZar, fromBase, shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { Sheet } from "@/components/ui/client";
import { Badge, Button, ExplorerLink, Notice, TickDisc } from "@/components/ui/primitives";
import { Blocked } from "@/components/shell/blocked";
import { fmt, useCopy } from "@/components/shell/copy";

export interface PayRequest {
  kind: PaymentReview["kind"];
  to: string;
  toLabel: string;
  amount: bigint;
  /** Where the money comes from. Vault payments are made by the estate's contract. */
  source?: "wallet" | "vault";
  /** A review prepared by the service (plain sends). Otherwise one is built from what the app already knows. */
  review?: PaymentReview;
  warnings?: string[];
  /**
   * The on-chain action for non-P2P payments. Must resolve to something carrying the transaction signature.
   * `again`: an earlier attempt of this same payment ran, so a step it may have finished (an approval) is read afresh.
   */
  execute?: (svc: HeirloomService, estate: string, again: boolean) => Promise<unknown>;
  successText?: string;
  /** A claim approved in the same go (its quote counts the approval's transaction and any stamp rent: M3). */
  approve?: "owner" | "verifier";
  claim?: string;
}
export interface PayResult { ok: boolean; code?: string; message?: string; signature?: string }
type Phase = "review" | "signing" | "pending" | "confirmed" | "failed";

interface PayApi { pay(req: PayRequest): Promise<PayResult>; online: boolean; rechecking: number }
const Ctx = createContext<PayApi | null>(null);
export function usePay(): PayApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePay must be used inside <PaymentProvider>");
  return v;
}

const STORE = "heirloom.pendingPayments";
const readPending = (): string[] => { try { return JSON.parse(window.localStorage.getItem(STORE) ?? "[]") as string[]; } catch { return []; } };
const writePending = (ids: string[]) => { try { window.localStorage.setItem(STORE, JSON.stringify(ids)); } catch { /* ignore */ } };

/** A transaction that was signed and sent but is not settled (lib/service/chain-errors.ts PaymentPending). */
function pendingOf(e: unknown): { paymentId: string; signature: string; kind?: string } | null {
  const p = e as { paymentId?: unknown; signature?: unknown; kind?: unknown } | null;
  return p && typeof p.paymentId === "string" && typeof p.signature === "string" ? { paymentId: p.paymentId, signature: p.signature, kind: typeof p.kind === "string" ? p.kind : undefined } : null;
}

const OPEN_STATUS = ["signing", "submitted", "pending"];

function signatureOf(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as { signature?: unknown; tx?: { signature?: unknown } };
  return typeof o.signature === "string" ? o.signature : typeof o.tx?.signature === "string" ? o.tx.signature : undefined;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return online;
}

export function PaymentProvider({ children }: { children: ReactNode }) {
  const { pay: copy } = useCopy();
  const { service, snap, session, walletUsdt, isMock, run, refresh, notify, explain, fx } = useEstate();
  const online = useOnline();
  const [req, setReq] = useState<PayRequest | null>(null);
  const [review, setReview] = useState<PaymentReview | null>(null);
  const [phase, setPhase] = useState<Phase>("review");
  const [signature, setSignature] = useState<string | undefined>();
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const resolver = useRef<((r: PayResult) => void) | null>(null);
  const activeId = useRef<string | null>(null);
  const reqRef = useRef<PayRequest | null>(null);
  // The kind of the transaction being checked: an earlier step (an approval) or the payment itself.
  const pendingKind = useRef<string | undefined>(undefined);
  const attempts = useRef(0);
  const [stepNote, setStepNote] = useState<string | null>(null);
  // The payment id being checked, for rendering (the ref is for the effects).
  const [checkingId, setCheckingId] = useState<string | null>(null);
  // The fee of a payment the contract makes, quoted from the network before it is approved (M3).
  const [quoting, setQuoting] = useState<"no" | "loading" | "failed">("no");
  const shownUser = useRef(0);
  const selfPay = useRef(false);
  const rate = fx?.usdtZar ?? null;
  // On a real network Heirloom's fee wallet pays the network fee of every program action it can sponsor
  // (chain.ts send); the review says so instead of "paid by you".
  const [sponsor, setSponsor] = useState<SponsorStatus | null>(null);
  useEffect(() => {
    // Wait for the service: until it has loaded isMock is still false, and the demo never needs this.
    if (!service || isMock) return;
    let alive = true;
    fetch("/api/sponsor").then((r) => (r.ok ? r.json() : null)).then((v: SponsorStatus | null) => { if (alive) setSponsor(v); }).catch(() => {});
    return () => { alive = false; };
  }, [service, isMock]);

  // Hydrate from localStorage after mount (not during render, so SSR markup matches).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPendingIds(readPending()); }, []);
  // Also pick up payments the service itself still has open: on load, on reconnect and when the tab returns.
  useEffect(() => {
    if (!service || !session) return;
    const sync = () => {
      if (!navigator.onLine) return;
      service.listPendingReceipts().then((list) => {
        if (list.length) setPendingIds((prev) => { const next = Array.from(new Set([...prev, ...list.map((r) => r.id)])); writePending(next); return next; });
      }).catch(() => undefined);
    };
    const vis = () => { if (document.visibilityState === "visible") sync(); };
    sync();
    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", vis);
    return () => { window.removeEventListener("online", sync); document.removeEventListener("visibilitychange", vis); };
  }, [service, session]);
  const track = useCallback((id: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = on ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id);
      writePending(next);
      return next;
    });
  }, []);

  // Re-check remembered pending payments: on load, on reconnect, then every few seconds. Never re-sends.
  useEffect(() => {
    if (!service || !online || pendingIds.length === 0) return;
    let alive = true;
    const check = async () => {
      for (const id of pendingIds) {
        try {
          const r = await service.getReceipt(id);
          if (!alive) return;
          if (!r || r.status === "confirmed" || r.status === "failed" || r.status === "cancelled") {
            track(id, false);
            if (id === activeId.current) {
              // An earlier step settled (an approval): back to the review to finish the payment itself.
              const step = r?.status === "confirmed" && reqRef.current?.execute && pendingKind.current && pendingKind.current !== reqRef.current.kind;
              if (step) { setStepNote(copy.pending.stepDone); setPhase("review"); }
              else if (r?.status === "confirmed") setPhase("confirmed");
              else if (r) { setError({ code: "generic", message: r.error ?? copy.failed.body }); setPhase("failed"); }
            } else if (r?.status === "confirmed") notify("ok", copy.recheck.confirmedPlain);
            else if (r) notify("error", copy.recheck.failed);
            void refresh();
          }
        } catch { /* still offline or busy: try again on the next tick */ }
      }
    };
    void check();
    const t = window.setInterval(check, 1500);
    return () => { alive = false; window.clearInterval(t); };
  }, [service, online, pendingIds, track, notify, refresh, copy]);

  /** What it costs now, and whether this wallet holds the SOL for its part. False when it couldn't be read. */
  const quote = async (r: PayRequest, id: string): Promise<{ changed: boolean } | null> => {
    if (!service || !snap) return null;
    setQuoting("loading");
    try {
      const q = await service.quoteFee(snap.estate.address, { kind: r.kind, to: r.to, amount: r.amount, approve: r.approve, claim: r.claim, selfPay: selfPay.current });
      if (activeId.current !== id) return null;
      const short = q.userLamports > Math.round(q.solBalance * 1e9);
      let changed = false;
      setReview((prev) => {
        if (!prev) return prev;
        changed = prev.fee.sponsored !== q.fee.sponsored || q.userLamports > shownUser.current;
        return { ...prev, fee: q.fee, balances: { ...prev.balances, sol: q.solBalance }, warnings: [...prev.warnings.filter((w) => w !== copy.review.noSol), ...(short ? [copy.review.noSol] : [])] };
      });
      shownUser.current = q.userLamports;
      setQuoting("no");
      return { changed };
    } catch {
      if (activeId.current === id) setQuoting("failed");
      return null;
    }
  };
  const pay = useCallback((r: PayRequest) => new Promise<PayResult>((resolve) => {
    const source = r.source ?? "wallet";
    const available = source === "vault" ? snap?.estate.vaultBalance ?? BigInt(0) : walletUsdt;
    const cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "localnet" ? "localnet" : "devnet";
    const built: PaymentReview = r.review ?? {
      id: `local_${Math.random().toString(36).slice(2)}`, kind: r.kind, from: source === "vault" ? snap?.estate.address ?? "" : session?.address ?? "", to: r.to, toLabel: r.toLabel, amount: r.amount,
      token: { symbol: "USD₮", mint: snap?.estate.usdtMint ?? "", verified: true },
      network: { name: `Solana ${cluster}`, cluster },
      fee: sponsor?.available && sponsor.feePayer
        ? { lamports: 10_000, sol: 0.00001, payer: sponsor.feePayer, sponsored: true }
        : { lamports: 5000, sol: 0.000005, payer: session?.address ?? "", sponsored: false },
      balances: { usdt: available, sol: session?.solBalance ?? 0, sufficient: available >= r.amount },
      warnings: r.warnings ?? [], simulated: isMock,
    };
    resolver.current = resolve;
    activeId.current = built.id;
    pendingKind.current = undefined;
    attempts.current = 0;
    reqRef.current = r;
    selfPay.current = false;
    setReview(built); setReq(r); setPhase("review"); setError(null); setSignature(undefined); setStepNote(null); setCheckingId(null);
    if (r.execute && !r.review) void quote(r, built.id);
  }), [snap, session, walletUsdt, isMock, sponsor]); // eslint-disable-line react-hooks/exhaustive-deps



  const finish = (result: PayResult) => { resolver.current?.(result); resolver.current = null; };
  const close = () => {
    if (phase === "signing") return; // never abandon a signature half way
    if (phase === "review") { finish({ ok: false, code: "cancelled" }); notify("info", copy.cancelled); }
    else finish({ ok: phase !== "failed", signature, ...(error ?? {}) });
    activeId.current = null;
    setReq(null); setReview(null);
  };

  // Submitted, not settled: "checking" on that payment id, never a failure that invites paying again (H8).
  const checking = (p: { paymentId: string; signature: string; kind?: string }) => {
    activeId.current = p.paymentId;
    setCheckingId(p.paymentId);
    pendingKind.current = p.kind;
    setSignature(p.signature);
    track(p.paymentId, true);
    setPhase("pending");
  };

  const approve = async () => {
    if (!req || !review || !service || phase !== "review") return; // guards against double-submit
    setPhase("signing"); setStepNote(null);
    if (req.execute) {
      // Read the cost again: what the user pays must be what they saw (M3).
      if (!req.review) {
        const before = shownUser.current;
        const fresh = await quote(req, review.id);
        if (!fresh) { setPhase("review"); return; }
        if (fresh.changed && shownUser.current > before) { setStepNote(copy.review.costChanged); setPhase("review"); return; }
      }
      const again = attempts.current++ > 0;
      let thrown: unknown = null;
      const fee = review.fee;
      const res = await run(`pay:${review.id}`, (s, est) => s.withShownFee(fee, () => req.execute!(s, est, again)).catch((e: unknown) => { thrown = e; throw e; }), undefined, true);
      if (!res.ok) {
        const pending = pendingOf(thrown);
        if (pending) { checking(pending); return; }
        // Heirloom can't pay the fee it said it would: show what the user would pay, and let them decide.
        if (res.code === "FeeChanged") { selfPay.current = true; setStepNote(copy.review.feeChanged); setPhase("review"); await quote(req, review.id); return; }
        setError({ code: res.code, message: res.message }); setPhase("failed"); return;
      }
      setSignature(signatureOf(res.value));
      setPhase("pending");
      window.setTimeout(() => { if (activeId.current === review.id) { setPhase("confirmed"); if (req.successText) notify("ok", req.successText); } }, 1600);
      return;
    }
    try {
      const receipt = await service.confirmSend(review);
      setSignature(receipt.signature);
      if (receipt.status === "confirmed") { setPhase("confirmed"); void refresh(); return; }
      if (receipt.status === "failed" && receipt.code === "FeeChanged") {
        const fresh = await service.reviewSend({ to: review.to, toLabel: review.toLabel, amountUsdt: fromBase(review.amount), selfPay: true, ...(review.bill ? { bill: review.bill } : {}) });
        activeId.current = fresh.id;
        setReview({ ...fresh, warnings: [...new Set([...review.warnings, ...fresh.warnings])] });
        setStepNote(copy.review.feeChanged); setPhase("review");
        return;
      }
      if (receipt.status === "failed" || receipt.status === "cancelled") { setError({ code: "generic", message: receipt.error ?? copy.failed.body }); setPhase("failed"); return; }
      track(review.id, true);
      setPhase("pending");
      void refresh();
    } catch (e) {
      // Signed already: it is being checked, whatever went wrong after (H8).
      const stored = await service.getReceipt(review.id).catch(() => null);
      if (stored?.signature && OPEN_STATUS.includes(stored.status)) { checking({ paymentId: review.id, signature: stored.signature, kind: review.kind }); return; }
      // A dropped connection mid-send is ambiguous: keep the id so it is re-checked instead of sent again.
      if (!navigator.onLine) { track(review.id, true); setError({ code: "generic", message: copy.failed.unknown }); setPhase("failed"); return; }
      setError(explain(e));
      setPhase("failed");
    }
  };

  // Trying again after a definite failure is a new payment with its own id: the failed one can never land now.
  const retry = async () => {
    if (!review || !req || !service) return;
    setError(null);
    if (req.review) {
      try {
        const fresh = await service.reviewSend({ to: review.to, toLabel: review.toLabel, amountUsdt: fromBase(review.amount), ...(review.bill ? { bill: review.bill } : {}) });
        activeId.current = fresh.id;
        setReview({ ...fresh, warnings: [...new Set([...review.warnings, ...fresh.warnings])] });
      } catch (e) { setError(explain(e)); setPhase("failed"); return; }
    } else {
      const id = `local_${Math.random().toString(36).slice(2)}`;
      activeId.current = id;
      setReview({ ...review, id });
    }
    pendingKind.current = undefined;
    setPhase("review");
  };

  const steps: Phase[] = ["review", "signing", "pending", "confirmed"];
  const at = phase === "failed" ? 1 : steps.indexOf(phase);
  const c = copy.review;
  const fromVault = (req?.source ?? "wallet") === "vault";
  const contractBlock = error && !["generic", "InsufficientFunds", "InvalidAddress", "cancelled"].includes(error.code);

  return (
    <Ctx.Provider value={{ pay, online, rechecking: pendingIds.filter((id) => id !== review?.id).length }}>
      {children}
      <Sheet open={!!req} onClose={close} title={phase === "review" ? c.title : phase === "signing" ? copy.signing.title : phase === "pending" ? copy.pending.title : phase === "confirmed" ? copy.confirmed.title : copy.failed.title} description={phase === "review" ? c.body : undefined} closeLabel={phase === "review" ? c.cancel : copy.failed.close}>
        {req && review && (
          <div className="flex flex-col gap-4">
            <ol aria-label={copy.stepsLabel} className="flex gap-1.5">
              {steps.map((st, i) => (
                <li key={st} aria-current={i === at ? "step" : undefined} className="flex flex-1 flex-col gap-1">
                  <span className={clsx("h-1.5 rounded-full transition-colors duration-300", phase === "confirmed" || i <= at ? "bg-ink" : "bg-line")} />
                  <span className={clsx("text-[0.7rem] font-semibold", i === at ? "text-ink" : "text-ink-2")}>{st === "review" ? copy.steps.review : st === "signing" ? copy.steps.sign : st === "pending" ? copy.steps.pending : copy.steps.confirmed}</span>
                </li>
              ))}
            </ol>

            {/* Amount and recipient stay visible through every phase */}
            <div className={clsx("rounded-lg border p-4 text-center", phase === "confirmed" ? "brand-panel confirm-pop border-ink" : phase === "pending" ? "border-[1.5px] border-dashed border-ink bg-surface" : phase === "failed" ? "border-2 border-ink bg-surface" : "border-line-strong bg-surface")}>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Badge tone="accent">{c.kinds[review.kind]}</Badge>
                {review.simulated && <Badge tone="warn">{c.simulated}</Badge>}
                {phase === "pending" && <Badge tone="warn"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />{copy.pending.badge}</Badge>}
                {phase === "confirmed" && <Badge tone="gold"><TickDisc />{copy.confirmed.badge}</Badge>}
              </div>
              <p className="mt-2 break-words font-display text-h1 tabular-nums">{formatUsdtExact(review.amount)}</p>
              <p className="min-h-6 text-ink-2 tabular-nums">{rate ? `≈ ${formatZar(review.amount, rate)}` : ""}</p>
              <p className="mt-1 font-semibold">{c.to} {review.toLabel}</p>
              <p className="font-mono text-small text-ink-2">{shortAddress(review.to, 6)}</p>
            </div>

            {phase === "review" && (
              <>
                <dl className="text-small">
                  {[
                    { k: c.from, v: fromVault ? c.viaContract : `${session?.label ?? ""} · ${shortAddress(review.from)}` },
                    // Pay a bill once: what it is for, the reference the payee sees, and how the invoice compared.
                    ...(review.bill?.note ? [{ k: c.billFor, v: review.bill.note }] : []),
                    ...(review.bill?.reference ? [{ k: c.reference, v: review.bill.reference }] : []),
                    ...(review.bill?.invoiceCheck ? [{ k: c.invoice, v: <span className={clsx("font-semibold", review.bill.invoiceCheck === "mismatch" && "rounded-[3px] bg-ink px-1.5 text-bg")}>{review.bill.invoiceCheck === "match" ? c.invoiceMatch : review.bill.invoiceCheck === "mismatch" ? c.invoiceMismatch : c.invoiceUnread}</span> }] : []),
                    { k: c.network, v: review.network.name },
                    { k: c.token, v: <span className={clsx("inline-flex items-center gap-1 font-semibold", review.token.verified ? "text-ink" : "rounded-[3px] bg-ink px-1.5 text-bg")}>{review.token.verified ? <BadgeCheck className="size-4" aria-hidden="true" /> : <ShieldAlert className="size-4" aria-hidden="true" />}{review.token.verified ? c.verified : c.unverified}</span> },
                    { k: c.fee, v: quoting === "loading" ? c.quoting : fmt(review.fee.sponsored ? c.feeSponsored : review.fee.payer === session?.address ? c.feeYou : c.feeBy, { sol: ((review.fee.networkLamports ?? review.fee.lamports) / 1e9).toFixed(6), payer: shortAddress(review.fee.payer) }) },
                    ...(review.fee.rentLamports ? [{ k: c.rent, v: fmt(review.fee.rentPayer === session?.address ? c.feeYou : review.fee.sponsored ? c.feeSponsored : c.feeBy, { sol: (review.fee.rentLamports / 1e9).toFixed(6), payer: shortAddress(review.fee.rentPayer ?? review.fee.payer) }) }] : []),
                    { k: fromVault ? c.balanceVault : c.balance, v: <>{formatUsdt(review.balances.usdt)}{review.balances.sufficient && <span className="block text-ink-2">{fmt(c.after, { amount: formatUsdt(review.balances.usdt - review.amount) })}</span>}</> },
                  ].map((row) => (
                    <div key={row.k} className="flex items-start justify-between gap-4 border-b border-line py-2.5 last:border-0">
                      <dt className="shrink-0 text-ink-2">{row.k}</dt>
                      <dd className="min-w-0 text-right font-medium">{row.v}</dd>
                    </div>
                  ))}
                </dl>
                {!review.token.verified && <Notice tone="danger" icon={<ShieldAlert className="size-5" aria-hidden="true" />}><p role="alert">{c.unverifiedWarning}</p></Notice>}
                {review.warnings.length > 0 && (
                  <Notice tone="warn" icon={<CircleAlert className="size-5" aria-hidden="true" />} title={c.warnings}>
                    <ul className="mt-1 list-disc space-y-1 pl-4">{review.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                  </Notice>
                )}
                {!review.balances.sufficient && (
                  <Notice tone="danger" icon={<CircleAlert className="size-5" aria-hidden="true" />} title={c.insufficientTitle}>
                    <p role="alert">{fmt(c.insufficientBody, { have: formatUsdt(review.balances.usdt), need: formatUsdt(review.amount) })}</p>
                  </Notice>
                )}
                {!online && <Notice tone="warn" icon={<WifiOff className="size-5" aria-hidden="true" />}><p role="status">{c.offline}</p></Notice>}
                {stepNote && <Notice tone={stepNote === copy.pending.stepDone ? "ok" : "warn"} icon={<Check className="size-5" aria-hidden="true" />}><p role="status">{stepNote}</p></Notice>}
                {quoting === "failed" && (
                  <Notice tone="warn" icon={<CircleAlert className="size-5" aria-hidden="true" />}>
                    <p role="alert">{c.quoteFailed}</p>
                    <Button small variant="secondary" className="mt-2" onClick={() => req && void quote(req, review.id)}>{copy.failed.recheck}</Button>
                  </Notice>
                )}
                <div className="flex gap-3">
                  <Button variant="secondary" className="flex-1" onClick={close}>{review.balances.sufficient ? c.cancel : c.changeAmount}</Button>
                  <Button className="flex-[2] min-h-13!" onClick={approve} disabled={!review.balances.sufficient || !review.token.verified || !online || quoting !== "no" || review.warnings.includes(c.noSol)}>{c.approve}</Button>
                </div>
              </>
            )}

            {phase === "signing" && (
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-6 text-center">
                <Loader2 className="size-10 animate-spin text-ink" aria-hidden="true" />
                <p className="text-lead font-semibold">{copy.signing.title}</p>
                <p className="max-w-xs text-small text-ink-2">{copy.signing.body}</p>
              </div>
            )}

            {phase === "pending" && (
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-4 text-center">
                <span className="relative grid size-14 place-items-center rounded-full border-2 border-dashed border-ink text-ink"><RefreshCw className="size-7 animate-spin [animation-duration:2.2s]" aria-hidden="true" /></span>
                <p className="max-w-sm text-small text-ink-2">{copy.pending.body}</p>
                {signature && <ExplorerLink signature={signature} label={copy.confirmed.receipt} srLabel={copy.confirmed.receiptSr} />}
              </div>
            )}

            {phase === "confirmed" && (
              <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 py-2 text-center">
                <span className="spring-pop relative my-2 grid size-20 place-items-center rounded-full bg-ink text-bg"><span className="confirm-ring absolute inset-0" aria-hidden="true" /><Check className="size-10" strokeWidth={3} aria-hidden="true" /></span>
                <p className="text-small text-ink-2">{copy.confirmed.body}</p>
                {signature && <ExplorerLink signature={signature} label={copy.confirmed.receipt} srLabel={copy.confirmed.receiptSr} />}
                <Button block onClick={close}>{copy.confirmed.done}</Button>
              </div>
            )}

            {phase === "failed" && error && (
              <div className="flex flex-col gap-3">
                {contractBlock
                  ? <Blocked code={error.code} message={error.message} />
                  : <Notice tone="danger" icon={<CircleAlert className="size-5" aria-hidden="true" />} title={error.message}><p role="alert">{pendingIds.includes(checkingId ?? review.id) ? "" : copy.failed.body}</p></Notice>}
                <div className="flex gap-3">
                  <Button variant="secondary" className="flex-1" onClick={close}>{copy.failed.close}</Button>
                  {!contractBlock && !pendingIds.includes(checkingId ?? review.id) && <Button className="flex-1" onClick={() => void retry()}>{copy.failed.retry}</Button>}
                </div>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </Ctx.Provider>
  );
}

/** Thin bars under the header: offline, and "re-checking" for payments still pending from earlier. */
export function ConnectionBars() {
  const { pay: copy } = useCopy();
  const { online, rechecking } = usePay();
  if (online && rechecking === 0) return null;
  return (
    <div role="status" aria-live="polite">
      {!online && (
        <p className="flex items-center justify-center gap-2 bg-ink px-4 py-2 text-center text-small font-medium text-bg"><WifiOff className="size-4 shrink-0" aria-hidden="true" />{copy.offline.banner}</p>
      )}
      {online && rechecking > 0 && (
        <p className="flex items-center justify-center gap-2 border-b border-dashed border-ink bg-surface px-4 py-2 text-center text-small font-semibold text-ink"><Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />{rechecking === 1 ? copy.recheck.banner : fmt(copy.recheck.bannerMany, { n: rechecking })}</p>
      )}
    </div>
  );
}
