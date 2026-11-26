"use client";
/** Continuity (plan.md §17): starter funds, practice wallets, what is left, ending a rule, referrals. */
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { continuity } from "@/content/continuity";
import { useLocale } from "@/lib/i18n/client";
import { useEstate } from "@/lib/hooks/estate";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useNow } from "@/lib/hooks/use-now";
import { formatUsdt, shortAddress } from "@/lib/format";
import { residualName } from "@/lib/continuity/names";
import { sweepableSurplus } from "@/lib/continuity/logic";
import { personKey, type MissingPerson } from "@/lib/continuity/practice";
import { FAUCET_URL, starterRefusalText, type RefusalText } from "@/lib/starter/refusal";
import type { EstateSnapshot } from "@/lib/service/types";
import type { Rule, Verdict, WillDraft } from "@/lib/types";
import { Button, Card, Field, inputClass } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { sweepHeldUntil } from "@/lib/guardians/decisions";
import { clock, shortName } from "@/components/guardians/derive";

const useText = () => continuity[useLocale()];
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A brand-new test-network wallet has nothing: offer starter funds. Never shown in the demo. */
export function StarterBanner() {
  const t = useText();
  const { session, refreshBalances, ready } = useWallet();
  const { isMock, run, busy } = useEstate();
  const path = usePathname();
  const [done, setDone] = useState<string | null>(null);
  const [refused, setRefused] = useState<(RefusalText & { wallet: string }) | null>(null);
  const address = session?.address ?? null;
  const known = !!session?.balanceKnown;
  // Balances show as zero until read: offer only after a real read, so a funded wallet never sees this.
  useEffect(() => {
    if (!isMock && ready && address && !known) void refreshBalances();
  }, [isMock, ready, address, known, refreshBalances]);
  // Not while the recovery phrase is on screen.
  if (isMock || !session || !known || done === session.address || path?.startsWith("/start")) return null;
  // A practice family member holds a little SOL for rent and needs no grant of their own. Someone who used the public
  // faucet holds far more, and still needs test USD₮ (the starter then sends only that).
  if (session.usdtBalance > BigInt(0) || (session.solBalance >= 0.002 && session.solBalance < 0.5)) return null;
  const get = async () => {
    setRefused(null);
    let why: { code?: string; retryAfterSecs?: number } = {};
    const r = await run("starter", (s) => s.requestStarter().catch((e: unknown) => { why = e as typeof why; throw e; }), t.starter.done, true);
    if (r.ok) {
      setDone(session.address);
      await refreshBalances();
    } else {
      setRefused({ ...starterRefusalText(t.starter, why, Date.now()), wallet: session.address });
    }
  };
  return (
    <Card className="mb-4" aria-label={t.starter.title}>
      <h2 className="text-h3">{t.starter.title}</h2>
      <p className="mt-1 text-ink-2">{t.starter.body}</p>
      <Button className="mt-3" loading={busy === "starter"} onClick={get}>{busy === "starter" ? t.starter.working : t.starter.cta}</Button>
      <div role="status">
        {refused?.wallet === session.address && (
          <>
            <p className="mt-3 text-small font-semibold">{refused.text}</p>
            {refused.faucet && (
              <p className="mt-1 text-small text-ink-2">
                {t.starter.faucet}{" "}
                <a href={FAUCET_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">faucet.solana.com</a>
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** Plan review: a wallet for everyone, pasted or made for practice. */
export function ConnectPeople({ draft, missing, wallets, onWallets }: {
  draft: WillDraft;
  missing: MissingPerson[];
  wallets: Record<string, string>;
  onWallets: (wallets: Record<string, string>, practice: boolean) => void;
}) {
  const t = useText();
  const { createPractice } = useWallet();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = draft.beneficiaries.length + draft.verifiers.length;
  if (!people) return null;

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await createPractice(missing.map((m) => ({ label: m.name, role: m.role })));
      onWallets({ ...wallets, ...Object.fromEntries(missing.map((m, i) => [m.key, made[i]])) }, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const paste = (key: string, value: string) => {
    const v = value.trim();
    setTyped((x) => ({ ...x, [key]: v }));
    if (ADDRESS.test(v)) onWallets({ ...wallets, [key]: v }, false);
  };

  const madeHere = [...draft.beneficiaries.map((_, i) => personKey("b", i)), ...draft.verifiers.map((_, i) => personKey("v", i))].some((k) => wallets[k]);
  if (!missing.length && !madeHere) return null;
  return (
    <section className="mt-6" aria-labelledby="connect-people">
      <h2 id="connect-people" className="text-h3">{t.practice.title}</h2>
      {missing.length ? (
        <>
          <p className="mt-2 text-ink-2">{t.practice.body}</p>
          <Button className="mt-3" loading={busy} onClick={make}>{busy ? t.practice.working : t.practice.cta}</Button>
          <p className="mt-2 text-small text-ink-2">{t.practice.note}</p>
          <div className="mt-3 grid gap-3">
            {missing.map((m) => (
              <Field
                key={m.key} htmlFor={`wallet-${m.key}`} label={fmt(t.practice.address, { name: m.name })}
                error={typed[m.key] && !ADDRESS.test(typed[m.key]) ? t.practice.invalid : null}
              >
                <input id={`wallet-${m.key}`} className={inputClass} autoComplete="off" spellCheck={false} value={typed[m.key] ?? ""} onChange={(e) => paste(m.key, e.target.value)} />
              </Field>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-2 text-ink-2" role="status">{t.practice.ready}</p>
      )}
      {error && <p role="alert" className="mt-2 text-small font-semibold">{error}</p>}
    </section>
  );
}

/** Plan review: who receives what is left. */
export function ResidualPicker({ draft, value, onChange }: { draft: WillDraft; value: string; onChange: (label: string) => void }) {
  const t = useText();
  if (!draft.beneficiaries.length) return null;
  return (
    <section className="mt-6">
      <h2 className="text-h3">{t.residual.title}</h2>
      <p className="mb-3 mt-2 text-ink-2">{t.residual.body}</p>
      <Field label={t.residual.label} htmlFor="residual-draft">
        <select id="residual-draft" className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {draft.beneficiaries.map((b) => <option key={b.label} value={b.label}>{b.label}</option>)}
        </select>
      </Field>
    </section>
  );
}

/** Vault: the owner names who receives what is left; after the unlock anyone can pay it out to them. */
export function ResidualCard({ snap, className }: { snap: EstateSnapshot; className?: string }) {
  const t = useText();
  const held = useCopy().guardians.rules.recipient.sweepHeld;
  const { run, busy } = useEstate();
  const { session } = useWallet();
  const now = useNow();
  const [pick, setPick] = useState("");
  const e = snap.estate;
  const to = snap.residual ?? null;
  const people = snap.beneficiaries.filter((b) => b.active);
  const canSet = e.status === "Active" && session?.address === e.owner && people.length > 0;
  const chosen = pick || to || people[0]?.wallet || "";
  const heldUntil = sweepHeldUntil(snap, now);
  const surplus = e.status === "Unlocked" && now ? sweepableSurplus(e.vaultBalance, snap.rules, snap.beneficiaries, now) : BigInt(0);

  return (
    <Card className={className}>
      <h2 className="text-h3">{t.residual.title}</h2>
      <p className="mt-1 text-ink-2">{t.residual.body}</p>
      <p className="mt-2 font-semibold">{to ? fmt(t.residual.goesTo, { name: residualName(snap, to) ?? shortAddress(to) }) : t.residual.none}</p>
      {canSet && (
        <div className="mt-3 grid gap-3">
          <Field label={t.residual.label} htmlFor="residual-set">
            <select id="residual-set" className={inputClass} value={chosen} onChange={(ev) => setPick(ev.target.value)}>
              {to && !people.some((b) => b.wallet === to) && <option value={to}>{residualName(snap, to) ?? shortAddress(to)}</option>}
              {people.map((b) => <option key={b.wallet} value={b.wallet}>{b.label}</option>)}
            </select>
          </Field>
          <Button variant="secondary" disabled={chosen === to} loading={busy === "residual"} onClick={() => run("residual", (s, est) => s.setResidual(est, chosen), t.residual.saved)}>
            {t.residual.save}
          </Button>
        </div>
      )}
      {e.status === "Unlocked" && to && (
        <div className="mt-3">
          <p className="text-small text-ink-2">{surplus > BigInt(0) ? fmt(t.residual.ready, { amount: formatUsdt(surplus) }) : t.residual.waiting}</p>
          {surplus > BigInt(0) && to && heldUntil !== null && now !== null && (
            <p role="status" className="mt-1 text-small font-semibold tabular-nums">{fmt(held, { name: shortName(residualName(snap, to) ?? shortAddress(to)), time: clock(heldUntil - now) })}</p>
          )}
          {surplus > BigInt(0) && (
            <Button className="mt-2" loading={busy === "sweep"} onClick={() => run("sweep", (s, est) => s.sweepResidual(est), t.residual.swept)}>{t.residual.sweep}</Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** The signed plan: the owner can end a rule while alive. */
export function EndRule({ snap, rule }: { snap: EstateSnapshot; rule: Rule }) {
  const t = useText();
  const { run, busy } = useEstate();
  const { session } = useWallet();
  const now = useNow();
  const [asking, setAsking] = useState(false);
  if (!now) return null;
  if (now > rule.validUntil) return <p className="mt-2 text-small font-semibold text-ink-2">{t.endRule.ended}</p>;
  if (snap.estate.status !== "Active" || session?.address !== snap.estate.owner) return null;
  const key = `end-${rule.address}`;
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className="mt-1 inline-flex min-h-11 items-center text-small font-semibold underline underline-offset-4">
        {t.endRule.cta}
      </button>
    );
  }
  return (
    <div className="mt-2" role="group" aria-label={t.endRule.cta}>
      <p className="text-small">{t.endRule.warn}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button small loading={busy === key} onClick={() => run(key, (s, est) => s.endRule(est, rule.address), t.endRule.done).then((r) => { if (r.ok) setAsking(false); })}>
          {t.endRule.confirm}
        </Button>
        <Button small variant="secondary" onClick={() => setAsking(false)}>{t.endRule.keep}</Button>
      </div>
    </div>
  );
}

/** Beside anything the agent referred instead of approving. */
export function ReferredNote({ verdict }: { verdict: Verdict }) {
  const t = useText();
  if (verdict !== "Referred") return null;
  return <p className="mt-2 text-small font-semibold">{t.referred}</p>;
}

export function RelistNote() {
  return <p className="mt-1 text-small text-ink-2">{useText().relist}</p>;
}
