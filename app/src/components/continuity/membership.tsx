"use client";
/** The owner takes an asset back, or removes a family member or payee (plan §18.4 U5, R15, R16). */
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Trash2, Undo2 } from "@/components/ui/icons";
import type { EstateSnapshot } from "@/lib/service";
import type { Asset, Base58 } from "@/lib/types";
import { rulesEndedByRemoval } from "@/lib/continuity/logic";
import { deathOpen } from "@/lib/guardians/decisions";
import { formatUsdt } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { Button, Field, inputClass } from "@/components/ui/primitives";
import { fmt, useCopy } from "@/components/shell/copy";
import { useWho } from "@/components/guardians/decision";
import { shortName } from "@/components/guardians/derive";
import { ActionResult, useAction } from "@/components/guardians/parts";

export function ReleaseAsset({ asset, title }: { asset: Asset; title: string }) {
  const t = useCopy().guardians.rules.release;
  const { act, busy, refusal } = useAction();
  const [asking, setAsking] = useState(false);
  if (asset.status !== "Held") return null;
  if (!asking) {
    return <Button variant="ghost" small onClick={() => setAsking(true)}><Undo2 className="size-4" aria-hidden="true" />{t.cta}</Button>;
  }
  const key = `release-${asset.address}`;
  const heading = fmt(t.title, { title });
  return (
    <div role="group" aria-label={heading} className="w-full min-w-0 rounded-md border-2 border-ink p-3">
      <p className="font-semibold">{heading}</p>
      <p className="mt-1 text-small">{t.body}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" small autoFocus onClick={() => setAsking(false)}>{t.keep}</Button>
        <Button small loading={busy === key} disabled={!!busy} onClick={() => void act(key, (s, est) => s.releaseAsset(est, asset.address), t.done)}>{t.confirm}</Button>
      </div>
      <ActionResult receipt={null} refusal={refusal} />
    </div>
  );
}

/** A family member the owner removed comes back into the plan (add_beneficiary allows it). */
export function RestoreMember({ snap, wallet, name }: { snap: EstateSnapshot; wallet: Base58; name: string }) {
  const t = useCopy().guardians.rules.remove;
  const { session } = useEstate();
  const { act, busy, refusal } = useAction();
  const [asking, setAsking] = useState(false);
  const e = snap.estate;
  if (session?.address !== e.owner || e.status !== "Active") return null;
  const key = `restore-${wallet}`;
  if (!asking) return <Button variant="ghost" small onClick={() => setAsking(true)} aria-label={fmt(t.restoreSr, { name })}><Undo2 className="size-4" aria-hidden="true" />{t.restore}</Button>;
  return (
    <div role="group" aria-label={fmt(t.restoreTitle, { name })} className="mt-2 w-full min-w-0 basis-full rounded-md border-2 border-ink bg-surface p-3 text-small">
      <p className="text-body font-semibold">{fmt(t.restoreTitle, { name })}</p>
      <p className="mt-1">{t.restoreBody}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" small autoFocus onClick={() => setAsking(false)}>{t.keep}</Button>
        <Button small loading={busy === key} disabled={!!busy} onClick={() => void act(key, (s, est) => s.restoreMember(est, wallet), t.restored)}>{fmt(t.restoreConfirm, { name: shortName(name) })}</Button>
      </div>
      <ActionResult receipt={null} refusal={refusal} />
    </div>
  );
}

/** "Remove", then what stops, which rules end, who receives what is left instead, and a confirmation. */
export function RemoveMember({ snap, kind, wallet, name }: { snap: EstateSnapshot; kind: "beneficiary" | "payee"; wallet: Base58; name: string }) {
  const { common, guardians } = useCopy();
  const t = guardians.rules.remove;
  const { session } = useEstate();
  const who = useWho(snap);
  const now = useNow(15000);
  const id = useId();
  const { act, busy, refusal } = useAction();
  const [asking, setAsking] = useState(false);
  const [heir, setHeir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!asking && refocus.current) { refocus.current = false; opener.current?.focus(); }
  }, [asking]);

  const e = snap.estate;
  if (session?.address !== e.owner || e.status !== "Active") return null;
  const short = shortName(name);

  if (!asking) {
    return (
      <Button ref={opener} variant="ghost" small onClick={() => setAsking(true)} aria-label={fmt(t.sr, { name })}>
        <Trash2 className="size-4" aria-hidden="true" />{t.cta}
      </Button>
    );
  }

  const person = kind === "beneficiary";
  // A family member's own wallet can be a payee too: it goes with them.
  const payee = person ? snap.payees.find((p) => p.wallet === wallet)?.wallet : wallet;
  const input = { beneficiary: person ? wallet : undefined, payee };
  const ending = now === null ? [] : rulesEndedByRemoval(snap, input, now);
  const moves = person && snap.residual === wallet;
  const fallback = snap.guardians?.fallback.recipients ?? [];
  const heirs = moves
    ? [...new Map([
      ...snap.beneficiaries.filter((b) => b.active).map((b) => [b.wallet, b.label] as const),
      ...fallback.filter((r) => !r.dead).map((r) => [r.wallet, r.name] as const),
    ].filter(([w]) => w !== wallet && w !== e.owner))]
    : [];
  // Removing someone from the family takes them off none of these lists (R16).
  const seats = snap.guardians?.seats ?? [];
  const seatNames = (list: "monitors" | "backups") => seats.filter((s) => s[list].some((p) => p.wallet === wallet))
    .map((s) => s.holder ? shortName(s.holderName) : guardians.seats[s.index]).join(", ");
  const watches = person ? seatNames("monitors") : "";
  const backs = person ? seatNames("backups") : "";
  const proceeds = person ? snap.assets.filter((a) => a.status !== "Sold" && a.proceedsTo === wallet).map((a) => a.title).join(", ") : "";
  const key = `remove-${kind}-${wallet}`;
  const close = () => { refocus.current = true; setAsking(false); setError(null); };
  const submit = async () => {
    if (moves && !heir) { setError(t.needHeir); return; }
    await act(key, (s, est) => s.removeMember(est, { ...input, newResidual: moves ? heir : undefined }), t.done);
  };

  return (
    <div role="group" aria-labelledby={`${id}-title`} className="mt-2 w-full min-w-0 basis-full rounded-md border-2 border-ink bg-surface p-3 text-small">
      <p id={`${id}-title`} className="text-body font-semibold">{fmt(t.title, { name })}</p>
      <p className="mt-1">{person ? t.stopsPerson : t.stopsPayee}</p>
      {person && payee && <p className="mt-1">{t.alsoPayee}</p>}
      {ending.length ? (
        <>
          <p className="mt-2 font-semibold">{t.ends}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {ending.map((r) => (
              <li key={r.address}>
                {fmt(t.rule, { category: common.status.category[r.category], name: shortName(who(r.beneficiary)), left: formatUsdt(r.lifetimeCap - r.spentTotal, { decimals: 0 }) })}
              </li>
            ))}
          </ul>
        </>
      ) : <p className="mt-2">{t.endsNone}</p>}
      {person && fallback.some((r) => r.wallet === wallet) && (
        <p className="mt-2">{t.stays} <Link href="/people#fallback" className="font-semibold underline underline-offset-4">{guardians.fallback.edit}</Link></p>
      )}
      {proceeds && (
        <p className="mt-2">{fmt(t.staysProceeds, { assets: proceeds })} <Link href="/car" className="font-semibold underline underline-offset-4">{t.toAssets}</Link></p>
      )}
      {(watches || backs) && (
        <p className="mt-2">
          {watches && `${fmt(t.staysWatch, { names: watches })} `}{backs && `${fmt(t.staysBackup, { names: backs })} `}
          <Link href="/people#guardians" className="font-semibold underline underline-offset-4">{t.toSeats}</Link>
        </p>
      )}
      {person && e.verifiers.includes(wallet) && (
        <p className="mt-2">{t.staysTrusted} <Link href="/people#guardians" className="font-semibold underline underline-offset-4">{t.toSeats}</Link></p>
      )}
      {person && <p className="mt-2">{t.noUndoPerson}</p>}
      {deathOpen(e) && <p className="mt-2 font-semibold">{t.cancels}</p>}
      {moves && (heirs.length ? (
        <Field label={t.residual} htmlFor={`${id}-heir`} error={error} className="mt-3">
          <select id={`${id}-heir`} value={heir} onChange={(ev) => { setHeir(ev.target.value); setError(null); }} className={inputClass}
            aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-heir-error` : undefined}>
            <option value="">{t.choose}</option>
            {heirs.map(([w, label]) => <option key={w} value={w}>{label}</option>)}
          </select>
        </Field>
      ) : <p className="mt-2 font-semibold">{t.noHeir}</p>)}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="ghost" small autoFocus onClick={close}>{t.keep}</Button>
        {(!moves || heirs.length > 0) && (
          <Button small loading={busy === key} disabled={!!busy || now === null} onClick={() => void submit()}>{fmt(t.confirm, { name: short })}</Button>
        )}
      </div>
      <ActionResult receipt={null} refusal={refusal} />
    </div>
  );
}
