"use client";
/** One trusted place ("seat"): who holds it, their backups and watchers, its succession history and any pending passing. */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Pencil, Repeat, Search, ShieldCheck, UsersRound } from "@/components/ui/icons";
import type { Seat } from "@/lib/guardians/types";
import type { EstateSnapshot } from "@/lib/service";
import { shortAddress } from "@/lib/format";
import { useEstate } from "@/lib/hooks/estate";
import { useNow } from "@/lib/hooks/use-now";
import { confirmRoute, deathOpen, replaceFor, seatReplace } from "@/lib/guardians/decisions";
import { Badge, Button } from "@/components/ui/primitives";
import { Avatar } from "@/components/shell/avatar";
import { fmt, useCopy } from "@/components/shell/copy";
import type { Person } from "./derive";
import { PeopleEditor } from "./people-editor";
import { ReplaceSeatForm } from "./replace-seat";
import { ActionResult, useAction, useGuardians } from "./parts";
import { SuccessionStatus } from "./succession";

export function SeatCard({ seat, snap }: { seat: Seat; snap: EstateSnapshot }) {
  const { guardians: c } = useCopy();
  const { session, role } = useEstate();
  const g = useGuardians();
  const { act, busy, receipt, refusal } = useAction();
  const now = useNow(5000);
  const [editing, setEditing] = useState<"backups" | "monitors" | null>(null);
  const [replacing, setReplacing] = useState(false);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // After the replace form closes, focus goes back to the button that opened it (once it is rendered again).
  useEffect(() => {
    if (!replacing && refocus.current && replaceRef.current) { refocus.current = false; replaceRef.current.focus(); }
  });
  const e = snap.estate;
  const me = session?.address;
  const ownerActive = role === "owner" && me === e.owner && e.status === "Active";
  const holderSelf = !!me && me === seat.holder;
  // A stale report gives way to new backups; a pending one still blocks them (R6).
  const times = seatReplace(e, seat);
  const reportBlocks = !!seat.succession && !(me && times && now !== null && now >= replaceFor(times, seat.succession.reportedBy, me));
  const canBackups = (ownerActive || holderSelf) && !reportBlocks;
  // R18: a monitor takes over from a family member's confirmation.
  const monitorClears = !!seat.succession?.confirmedBy && confirmRoute(e, seat) === "family";
  const canMonitors = ownerActive;
  const watching = seat.monitors.some((m) => m.wallet === me);
  const holders = (g?.seats ?? []).map((s) => s.holder);

  // People the owner already knows: the family, the other trusted people and anyone already named somewhere.
  const known = new Map<string, Person>();
  for (const b of snap.beneficiaries) if (b.active) known.set(b.wallet, { wallet: b.wallet, name: b.label.replace(/\s*\(.*\)$/, "") });
  for (const s of g?.seats ?? []) for (const p of [...s.backups, ...s.monitors]) known.set(p.wallet, p);
  const suggestions = [...known.values()].filter((p) => p.wallet !== e.owner && p.wallet !== e.agent);

  const save = async (kind: "backups" | "monitors", list: Person[]) => {
    const res = kind === "backups"
      ? await act(`backups-${seat.index}`, (s, est) => s.setSeatBackups(est, seat.index, list), c.seat.savedBackups)
      : await act(`monitors-${seat.index}`, (s, est) => s.setSeatMonitors(est, seat.index, list), c.seat.savedMonitors);
    if (res.ok) setEditing(null);
  };

  /** Closes the replace form and puts focus back on the button that opened it. */
  const closeReplace = () => { refocus.current = true; setReplacing(false); };
  const replace = async (person: Person) => {
    const res = await act(`replace-${seat.index}`, (s, est) => s.ownerReplaceSeat(est, seat.index, person), c.replace.done);
    if (res.ok) closeReplace();
  };

  const list = (kind: "backups" | "monitors") => {
    const people = kind === "backups" ? seat.backups : seat.monitors;
    const may = kind === "backups" ? canBackups : canMonitors;
    const title = kind === "backups" ? c.seat.backupsTitle : c.seat.monitorsTitle;
    const why = kind === "backups" ? c.seat.backupsWhy : c.seat.monitorsWhy;
    return (
      <section aria-label={`${title}: ${seat.holderName}`} className="mt-3 border-t border-line pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="flex items-center gap-1.5 font-sans text-small font-semibold uppercase tracking-[0.1em]">
            {kind === "backups" ? <UsersRound className="size-4" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}{title}
          </h4>
          {may && editing !== kind && !replacing && (
            <Button variant="quiet" small onClick={() => setEditing(kind)} aria-label={`${kind === "backups" ? c.seat.editBackups : c.seat.editMonitors}: ${seat.holderName}`}>
              <Pencil className="size-4" aria-hidden="true" />{c.edit}
            </Button>
          )}
        </div>
        <p className="mt-0.5 text-small text-ink-2">{why}</p>
        {editing === kind ? (
          <PeopleEditor
            note={kind === "monitors" && monitorClears ? c.rules.seat.monitorClears : undefined}
            kind={kind} seat={seat} owner={e.owner} holders={holders} initial={people.map((p) => ({ ...p }))} suggestions={suggestions}
            busy={busy === `${kind}-${seat.index}`} onSave={(l) => void save(kind, l)} onCancel={() => setEditing(null)}
          />
        ) : people.length === 0 ? (
          <p className="mt-1.5 text-small">{kind === "backups" ? c.seat.backupsEmpty : c.seat.monitorsEmpty}</p>
        ) : (
          <ol className="mt-1.5 flex flex-col gap-1">
            {people.map((p, i) => (
              <li key={`${p.wallet}-${p.name}`} className="flex min-w-0 items-center gap-2 text-small">
                <span className="grid size-6 shrink-0 place-items-center rounded-full border border-ink text-[0.7rem] font-bold" aria-hidden="true">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}{p.wallet === me && <> <Badge tone="accent">{c.you}</Badge></>}</span>
                <span className="shrink-0 font-mono text-[0.7rem] text-ink-2">{shortAddress(p.wallet)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  };

  return (
    <li className={clsx("min-w-0 rounded-md border bg-surface p-3", seat.succession ? "border-[1.5px] border-dashed border-ink" : "border-line")}>
      <div className="flex items-center gap-3">
        <Avatar name={seat.vacant ? "?" : seat.holderName} role="verifier" className="size-11" />
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 font-sans text-body font-semibold tracking-normal">
            {seat.vacant ? c.vacant : seat.holderName}
            {holderSelf && <Badge tone="accent">{c.you}</Badge>}
            {watching && <Badge tone="warn">{c.seat.watching}</Badge>}
          </h3>
          <p className="text-small text-ink-2">{c.seats[seat.index] ?? ""}</p>
          {seat.holder && <p className="font-mono text-[0.75rem] text-ink-2">{shortAddress(seat.holder)}</p>}
        </div>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-small">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-semibold">{c.seat.history}: </span>
          {seat.vacant ? c.seat.historyVacant : seat.generation === 0 ? c.seat.historyFirst : fmt(c.seat.historyLater, { name: seat.holderName, n: seat.generation + 1 })}
        </span>
      </p>
      {ownerActive && !replacing && (
        <Button
          ref={replaceRef} variant="secondary" small className="mt-3"
          onClick={() => { setEditing(null); setReplacing(true); }}
          aria-label={seat.vacant ? fmt(c.replace.fillSr, { place: c.seats[seat.index] ?? "" }) : fmt(c.replace.ctaSr, { name: seat.holderName })}
        >
          <Repeat className="size-4" aria-hidden="true" />{seat.vacant ? c.replace.fillCta : c.replace.cta}
        </Button>
      )}
      {replacing && (
        <ReplaceSeatForm
          seat={seat} owner={e.owner} agent={e.agent} cancelsPassing={deathOpen(e)} holders={holders} suggestions={suggestions}
          openObjection={(g?.objections ?? []).some((o) => o.status === "Open" && o.kind === "Succession" && o.seatIndex === seat.index)}
          otherSeats={(g?.seats ?? []).filter((s) => s.index !== seat.index)}
          busy={busy === `replace-${seat.index}`} onSubmit={(p) => void replace(p)} onCancel={closeReplace}
        />
      )}
      {seat.succession && <SuccessionStatus seat={seat} />}
      {list("backups")}
      {list("monitors")}
      {holderSelf && !ownerActive && canBackups && <p className="mt-2 text-small text-ink-2">{c.seat.holderMayEdit}</p>}
      <ActionResult receipt={receipt} refusal={refusal} />
    </li>
  );
}
