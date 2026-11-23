"use client";
import { useState, type FormEvent } from "react";
import clsx from "clsx";
import { m as motion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import { ArrowDownToLine, ArrowUpFromLine, HeartPulse, Landmark, Lock, ShieldCheck, Wallet } from "@/components/ui/icons";
import type { ScreensCopy } from "@/content/screens";
import { useLocalized } from "@/lib/i18n/client";
import type { EstateSnapshot } from "@/lib/service";
import { formatUsdt, formatUsdtExact, formatZar, fromBase, toBase } from "@/lib/format";
import { amountHint, amountText, parseAmount } from "@/lib/amount";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, ButtonLink, Card, ExplorerLink, Field, inputClass, Meter, Money, Notice, PageHeader } from "@/components/ui/primitives";
import { fmt, timeAgo, useCopy } from "@/components/shell/copy";
import { Gate, HeaderFrame } from "@/components/shell/gate";
import { usePay } from "@/components/pay/payment";
import { ResidualCard } from "@/components/continuity/continuity";
import { useStillHere } from "@/components/guardians/decision";

type Copy = ScreensCopy["vault"];

/** Animated with motion, so it brings its own <MotionScope> (the first pages never load the library). */
export function VaultScreen(props: Parameters<typeof VaultScreenBody>[0]) {
  return <MotionScope><VaultScreenBody {...props} /></MotionScope>;
}

function VaultScreenBody({ copy: english }: { copy: Copy }) {
  const copy = useLocalized(english, (t) => t.screens.vault);
  return <Gate roles={["owner"]} frame={<HeaderFrame width="max-w-3xl" eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />}>{({ snap }) => <Vault copy={copy} snap={snap!} />}</Gate>;
}

function Vault({ copy, snap }: { copy: Copy; snap: EstateSnapshot }) {
  const { common, guardians } = useCopy();
  const { fx, busy, walletUsdt } = useEstate();
  const { checkIn, cancels } = useStillHere(copy.heartbeat.done);
  const here = guardians.rules.here;
  const now = useNow(10000);
  const { pay } = usePay();
  const { session } = useEstate();
  const e = snap.estate;
  const rate = fx?.usdtZar ?? null;
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const active = e.status === "Active";
  const n = parseAmount(amount) ?? Number.NaN;
  const valid = Number.isFinite(n) && n > 0;
  const limit = tab === "deposit" ? walletUsdt : e.vaultBalance;
  // What live rules can still pay: an ended one promises nothing.
  const promised = snap.rules.reduce((sum, r) => (now !== null && now > r.validUntil ? sum : sum + (r.lifetimeCap - r.spentTotal)), BigInt(0));
  const cover = promised > BigInt(0) ? Math.min(1, Number(e.vaultBalance) / Number(promised)) : 0;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!valid) { setError(amount.trim() && Number.isNaN(n) ? common.amountUnclear : copy.amountError); return; }
    if (toBase(n) > limit) { setError(tab === "deposit" ? copy.tooMuchWallet : copy.tooMuchVault); return; }
    setError(null);
    const res = tab === "deposit"
      ? await pay({ kind: "vault-deposit", to: e.address, toLabel: copy.payVault, amount: toBase(n), execute: (s, est) => s.deposit(est, n), successText: copy.deposited })
      : await pay({ kind: "program", source: "vault", to: session?.address ?? "", toLabel: copy.payWallet, amount: toBase(n), execute: (s, est) => s.withdraw(est, n), successText: copy.withdrawn });
    if (res.ok) { setLast(res.signature ?? null); setAmount(""); }
  };

  const quick = tab === "deposit" ? [1000, 5000, 10000] : [500, 1000, 5000];

  const checkInCard = e.status !== "Unlocked" && (
    <Card className={clsx(cancels ? "mb-4" : "mt-4", "flex flex-wrap items-center justify-between gap-3", cancels && "border-2 border-l-8 border-ink")}>
      <div className="min-w-0 max-w-md">
        <h2 className="text-h3">{cancels ? here.title : copy.heartbeat.title}</h2>
        <p className="mt-1 text-ink-2">{cancels ? here.body : copy.heartbeat.body}</p>
        {cancels && <p className="mt-2 font-semibold">{here.warning}</p>}
        <p className="mt-1 min-h-5 text-small text-ink-2">{now !== null ? fmt(copy.heartbeat.last, { when: timeAgo(e.lastHeartbeat, now, common.time) }) : ""}</p>
      </div>
      <Button variant={cancels ? "primary" : "secondary"} loading={busy === "heartbeat"} onClick={() => void checkIn()}>
        <HeartPulse className="size-5" aria-hidden="true" />{cancels ? here.cta : copy.heartbeat.cta}
      </Button>
    </Card>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} body={copy.body} />
      {cancels && checkInCard}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="flex items-center gap-2 text-small font-semibold text-accent"><Landmark className="size-4" aria-hidden="true" />{copy.balance}</p>
          <motion.div key={e.vaultBalance.toString()} initial={{ y: 4 }} animate={{ y: 0 }}><Money base={e.vaultBalance} rate={rate} size="lg" className="mt-1" /></motion.div>
        </Card>
        <Card>
          <p className="flex items-center gap-2 text-small font-semibold text-ink-2"><Wallet className="size-4" aria-hidden="true" />{copy.wallet}</p>
          <Money base={walletUsdt} rate={rate} size="lg" className="mt-1" />
        </Card>
      </div>

      {!active ? (
        <Notice tone="warn" icon={<Lock className="size-5" aria-hidden="true" />} title={copy.locked.title} className="mt-4">
          <p>{copy.locked.body}</p>
          <ButtonLink href="/family" small variant="secondary" className="mt-3">{copy.lockedCta}</ButtonLink>
        </Notice>
      ) : (
        <Card className="mt-4">
          <div role="tablist" aria-label={copy.tabsLabel} className="flex rounded-full border border-line-strong bg-surface p-1">
            {(["deposit", "withdraw"] as const).map((t) => (
              <button
                key={t} type="button" role="tab" aria-selected={tab === t} id={`vault-tab-${t}`} aria-controls="vault-panel"
                onClick={() => { setTab(t); setError(null); setAmount(""); }}
                className={clsx("inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full text-small font-semibold transition-colors", tab === t ? "bg-ink text-bg" : "text-ink-2")}
              >
                {t === "deposit" ? <ArrowDownToLine className="size-4" aria-hidden="true" /> : <ArrowUpFromLine className="size-4" aria-hidden="true" />}
                {copy.tabs[t]}
              </button>
            ))}
          </div>
          <div id="vault-panel" role="tabpanel" aria-labelledby={`vault-tab-${tab}`}>
          <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-3">
            <Field label={copy.amount} htmlFor="vault-amount" error={error} hint={amountHint(amount, (x) => (x > 0 ? `= ${formatUsdtExact(toBase(x))}${rate ? ` · ${fmt(copy.amountHint, { zar: formatZar(toBase(x), rate) })}` : ""}` : copy.onlyUsdt), { unclear: common.amountUnclear, format: `${copy.onlyUsdt} ${common.amountFormat}` })}>
              <div className="relative">
                <input
                  id="vault-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount}
                  onChange={(ev) => { setAmount(ev.target.value); setError(null); }}
                  aria-invalid={!!error} aria-describedby={error ? "vault-amount-error" : "vault-amount-hint"}
                  className={`${inputClass} min-h-16 pr-20 font-display text-h2 tabular-nums`}
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-semibold text-ink-2">USD₮</span>
              </div>
            </Field>
            <div role="group" aria-label={copy.quick} className="flex flex-wrap gap-2">
              {quick.map((q) => (
                <button key={q} type="button" onClick={() => { setAmount(String(q)); setError(null); }} className="min-h-11 rounded-full border border-line-strong/70 px-4 text-small font-medium tabular-nums hover:bg-surface-2">
                  {q.toLocaleString("en-ZA")}
                </button>
              ))}
              <button type="button" onClick={() => { setAmount(amountText(fromBase(limit))); setError(null); }} className="min-h-11 rounded-full border border-line-strong/70 px-4 text-small font-medium hover:bg-surface-2">{copy.max}</button>
            </div>
            <Button type="submit" disabled={!!busy} className="mt-1 min-h-13!">{tab === "deposit" ? copy.deposit : copy.withdraw}</Button>
            {last && (
              <p className="flex flex-wrap items-center gap-x-3 text-small text-ink-2">{copy.last}: <ExplorerLink signature={last} label={copy.receipt} srLabel={copy.receiptSr} /></p>
            )}
          </form>
          </div>
        </Card>
      )}

      <ResidualCard snap={snap} className="mt-4" />

      {snap.rules.length > 0 && (
        <Card className="mt-4">
          <h2 className="flex items-center gap-2 text-h3"><ShieldCheck className="size-5 text-amber" aria-hidden="true" />{copy.covers.title}</h2>
          <p className="mt-1 text-ink-2">{fmt(copy.covers.body, { total: formatUsdt(promised, { decimals: 0 }), pct: Math.round(cover * 100) })}</p>
          <div className="mt-3"><Meter value={cover} label={copy.covers.meter} tone={cover >= 1 ? "accent" : "brass"} /></div>
        </Card>
      )}

      {!cancels && checkInCard}
    </div>
  );
}
