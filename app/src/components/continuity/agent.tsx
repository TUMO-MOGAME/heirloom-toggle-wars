"use client";
/** Replacing the agent (plan §18.4 U5): the owner alone, or the trusted people's votes. What an agent can and can't do. */
import { useId, useState, type FormEvent } from "react";
import { Check, Repeat } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import { agentVoteFor, agentVoteFrom, agentVoteRule, deathOpen, hasLivingSeat, isHeld } from "@/lib/guardians/decisions";
import { clockTime } from "@/lib/assets/sale-wait";
import { useLocale } from "@/lib/i18n/client";
import { useNow } from "@/lib/hooks/use-now";
import { eligibleSeats, NEVER, recoveryTimeout } from "@/lib/death-rules";
import { clock } from "@/components/guardians/derive";
import { useEstate } from "@/lib/hooks/estate";
import { shortAddress } from "@/lib/format";
import { Button, Field, inputClass, Notice } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { looksLikeWallet } from "@/components/guardians/derive";
import { useWho } from "@/components/guardians/decision";
import { ActionResult, useAction } from "@/components/guardians/parts";

export function AgentControl({ snap }: { snap: EstateSnapshot }) {
  const { rules } = useCopy().guardians;
  const t = rules.agent;
  const { session } = useEstate();
  const who = useWho(snap);
  const id = useId();
  const { act, busy, receipt, refusal } = useAction();
  const [asking, setAsking] = useState(false);
  const [wallet, setWallet] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<{ at: "wallet" | "ack"; text: string } | null>(null);
  const e = snap.estate;
  const me = session?.address;
  const owner = me === e.owner && e.status === "Active";
  const voter = isHeld(me) && e.verifiers.includes(me);
  const open = snap.agentVotes ?? [];
  // The program's number now (lib/guardians/decisions, as the services count it): every held seat before the unlock,
  // two or the only one left after it, or once a reported passing has stood unanswered.
  const now = useNow(15000) ?? undefined;
  const rule = agentVoteRule(e, now);
  const locale = useLocale();
  const when = (at: number) => (now === undefined ? "" : clockTime(at, now, locale));
  // The only trusted person left who would gain waits twice the recovery timeout before their vote counts.
  const from = voter ? agentVoteFrom(snap, me) : null;
  const early = from !== null && (now ?? 0) < from;
  // Before the unlock one person alone can never reach the two votes it takes, unless the recovery route opens.
  const alone = voter && rule.needed > eligibleSeats(e.verifiers).length;
  const routeLine = rule.recoveryAt !== undefined && <span className="block font-normal text-ink-2">{fmt(t.recoveryAt, { time: when(rule.recoveryAt) })}</span>;
  const needLine = (
    <p className="mt-2 text-small font-semibold tabular-nums">
      {fmt(t.needNow, { need: rule.needed })}{rule.why === "recovery" && <span className="block font-normal text-ink-2">{t.needRecovery}</span>}
      {routeLine}
      {early && <span className="block font-normal">{from === NEVER ? fmt(t.gainerNever, { time: clock(2 * recoveryTimeout(e.waitingPeriodSecs)) }) : fmt(t.gainerAt, { time: when(from ?? 0) })}</span>}
    </p>
  );

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const w = wallet.trim();
    if (!looksLikeWallet(w) || !isHeld(w)) { setError({ at: "wallet", text: t.invalid }); return; }
    if (w === e.agent || w === e.owner || e.verifiers.includes(w)) { setError({ at: "wallet", text: t.notAllowed }); return; }
    if (!ack) { setError({ at: "ack", text: t.ackRequired }); return; }
    setError(null);
    const res = owner
      ? await act("agent", (s, est) => s.setAgent(est, w), t.changed)
      : await act("agent", (s, est) => s.voteAgent(est, w), t.voted);
    if (res.ok) { setAsking(false); setWallet(""); setAck(false); }
  };

  const walletError = error?.at === "wallet" ? error.text : null;
  return (
    <div className="mt-3 min-w-0">
      <div className="grid gap-3 text-small sm:grid-cols-2">
        {([["canTitle", "can"], ["cannotTitle", "cannot"]] as const).map(([title, list]) => (
          <div key={title} className="min-w-0">
            <h3 className="font-sans text-small font-semibold">{t[title]}</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">
              {t[list].map((x) => <li key={x}>{x}</li>)}
            </ul>
          </div>
        ))}
      </div>

      {open.length > 0 && (
        <section aria-labelledby={`${id}-votes`} className="mt-4">
          <h3 id={`${id}-votes`} className="font-sans text-body font-semibold">{t.votes}</h3>
          <ul className="mt-2 grid gap-2 *:min-w-0">
            {open.map(({ candidate }) => {
              const v = agentVoteFor(snap, candidate, now);
              const voted = !!me && v.voters.includes(me);
              const finish = voted && v.got >= v.needed;
              return (
                <li key={candidate} className="rounded-md border border-line-strong p-3 text-small">
                  <p className="break-all font-mono">{candidate}</p>
                  <p className="mt-1 font-semibold tabular-nums">{fmt(t.progress, { got: v.got, need: v.needed })}</p>
                  <p className="text-ink-2">{fmt(t.votedBy, { names: v.voters.map(who).join(", ") })}</p>
                  {voter && (voted && !finish ? <p className="mt-1">{t.waiting}</p> : !alone && !early && (
                    <>
                      <p className="mt-2 text-ink-2">{t.warn}</p>
                      <Button small className="mt-2" loading={busy === `vote-${candidate}`} disabled={!!busy}
                        onClick={() => void act(`vote-${candidate}`, (s, est) => s.voteAgent(est, candidate), t.voted)}>
                        <Check className="size-4" aria-hidden="true" />{finish ? t.finish : t.vote}
                        <span className="sr-only"> {shortAddress(candidate)}</span>
                      </Button>
                    </>
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(owner || (voter && hasLivingSeat(e))) && (
        alone || early ? <div className="mt-3 text-small text-ink-2">{alone && <p>{t.alone}</p>}{needLine}</div> : !asking ? (
          <>
            {voter && !owner && needLine}
            <Button variant="secondary" small className="mt-3" onClick={() => setAsking(true)}>
              <Repeat className="size-4" aria-hidden="true" />{t.replace}
            </Button>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface-2/50 p-3">
            <p className="text-small">{owner ? t.ownerBody : t.votersBody}</p>
            {!owner && needLine}
            <Notice tone="warn"><p>{t.warn}</p></Notice>
            {owner && deathOpen(e) && <p className="text-small font-semibold">{rules.here.warning}</p>}
            <Field label={t.wallet} htmlFor={`${id}-agent`} error={walletError}>
              <input
                id={`${id}-agent`} autoFocus value={wallet} autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`}
                onChange={(ev) => { setWallet(ev.target.value); setError(null); }}
                aria-invalid={!!walletError || undefined} aria-describedby={walletError ? `${id}-agent-error` : undefined}
              />
            </Field>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-line-strong bg-surface p-3 text-small">
              <input type="checkbox" checked={ack} onChange={(ev) => { setAck(ev.target.checked); setError(null); }} className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]" />
              <span>{t.ack}</span>
            </label>
            {error?.at === "ack" && <p role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold">{error.text}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => { setAsking(false); setError(null); }}>{t.cancel}</Button>
              <Button type="submit" className="flex-1" loading={busy === "agent"}>{owner ? t.submitOwner : t.submitVote}</Button>
            </div>
          </form>
        )
      )}
      <ActionResult receipt={receipt} refusal={refusal} />
    </div>
  );
}
