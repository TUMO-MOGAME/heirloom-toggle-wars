"use client";
/**
 * A person's card: who trusted them and how many promises they kept, their roles with years, the kept promises in
 * plain words with proof (Solana Explorer on devnet, "simulated" in the demo) and what they received (kind and title
 * only). No amounts and no scores, ever. Hidden people and children show no details. A living adult viewing their
 * own card can hide themselves. The photo sits at the top, with "Add / Change / Remove photo" for whoever may change
 * it (components/tree/photo.tsx); a memorial photo says who added it and when.
 */
import { CarFront, ExternalLink, Eye, EyeOff, HandHeart, Info, Sparkles } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { explorerTx, shortAddress } from "@/lib/format";
import type { PersonId, TreeAtYear } from "@/lib/tree/types";
import { yearOf } from "@/lib/tree/timeline";
import { PhotoPanel } from "./photo";
import {
  assetText, factsFor, factsLine, fullLabel, isMinorAt, keptText, lifeText, roleTermText, shortLabel, type Copy,
} from "./words";

export function PersonCardBody({
  at, id, copy, mock, viewer, busy, onHide, photoRight = null, photoBusy = false, addedByName = "", onPhoto, letters,
}: {
  at: TreeAtYear; id: PersonId; copy: Copy; mock: boolean; viewer: string | null; busy?: boolean;
  /** Present when hiding is possible on this screen. */
  onHide?: (hidden: boolean) => void;
  /** Who may change this person's photo here (lib/tree/photos.ts photoConsent), or null. */
  photoRight?: "own" | "owner" | null;
  photoBusy?: boolean;
  /** The short name of whoever added the photo (for a memorial photo's label). */
  addedByName?: string;
  /** Saves a prepared photo (or null to remove it); resolves true when saved. */
  onPhoto?: (src: string | null) => Promise<boolean>;
  /** Letters for later that opened for this person ("2 letters from Thabo"), up to the slider's year. */
  letters?: React.ReactNode;
}) {
  const p = at.people.find((x) => x.id === id);
  if (!p) return null;
  const nameOf = (pid: PersonId) => shortLabel(copy, at.people.find((x) => x.id === pid), at.year);
  const me = !!viewer && p.wallets.includes(viewer);
  const photo = (
    <PhotoPanel
      p={p} name={shortLabel(copy, p, at.year)} me={me} copy={copy} right={p.hidden ? null : photoRight}
      addedByName={addedByName} busy={photoBusy} onSave={onPhoto}
    />
  );
  // Hiding is for a living adult on their own card (and showing again, once hidden).
  const canHide = me && p.alive && !isMinorAt(p, at.year) && !!onHide;
  const hideButton = canHide && (
    <div className="grid gap-1.5 border-t border-line pt-4">
      <Button variant="secondary" small loading={busy} onClick={() => onHide!(!p.hidden)}>
        {p.hidden ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
        {p.hidden ? copy.card.show : copy.card.hide}
      </Button>
      {!p.hidden && <p className="text-small text-ink-2">{copy.card.hideNote}</p>}
    </div>
  );

  if (p.hidden || isMinorAt(p, at.year)) {
    return (
      <div className="grid gap-4">
        {photo}
        <p className="flex items-start gap-2 text-ink-2"><Info className="mt-1 size-4 shrink-0" aria-hidden="true" />{p.hidden ? copy.person.hiddenBody : copy.person.minorBody}</p>
        {hideButton}
      </div>
    );
  }

  const f = factsFor(at, id);
  const life = lifeText(copy, p);
  return (
    <div className="grid gap-5">
      {photo}
      <div>
        {life && <p className="text-small text-ink-2 tabular-nums">{life}{me ? ` · ${copy.person.you}` : ""}</p>}
        <p className="mt-1 font-semibold" data-facts>{factsLine(copy, f)}</p>
        {p.ownsEstate && <p className="mt-1 text-small text-ink-2">{copy.person.ownPlan}</p>}
        {letters}
      </div>

      <section aria-labelledby={`roles-${id}`}>
        <h3 id={`roles-${id}`} className="text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.card.roles}</h3>
        {f.roles.length === 0 ? <p className="mt-1.5 text-small text-ink-2">{copy.card.rolesEmpty}</p> : (
          <ul className="mt-2 grid gap-2">
            {f.roles.map((e) => (
              <li key={e.id} className="flex items-start gap-2.5">
                <RoleSwatch role={e.role} className="mt-2.5" />
                <span>{roleTermText(copy, e, nameOf)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`kept-${id}`}>
        <h3 id={`kept-${id}`} className="text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.card.promises}</h3>
        {f.promises.length === 0 ? <p className="mt-1.5 text-small text-ink-2">{copy.card.promisesEmpty}</p> : (
          <ul className="mt-2 grid gap-2.5">
            {f.promises.map((k) => (
              <li key={k.id} className="rounded-md border border-line bg-surface p-3">
                <p className="font-medium">{keptText(copy, k, nameOf)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {k.imagined && <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-ink-2"><Sparkles className="size-3.5" aria-hidden="true" />{copy.card.imagined}</span>}
                  {k.proofs.slice(0, 3).map((s) => <Proof key={s} sig={s} copy={copy} mock={mock} />)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`assets-${id}`}>
        <h3 id={`assets-${id}`} className="text-small font-semibold uppercase tracking-[0.12em] text-ink-2">{copy.card.assets}</h3>
        {f.received.length === 0 ? <p className="mt-1.5 text-small text-ink-2">{copy.card.assetsEmpty}</p> : (
          <ul className="mt-2 grid gap-2">
            {f.received.map(({ asset, step }) => (
              <li key={`${asset.id}-${step.ts}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="inline-flex items-center gap-2 font-medium">{asset.kind === "Car" || asset.kind === "Motorbike" ? <CarFront className="size-4 shrink-0 text-amber" aria-hidden="true" /> : <HandHeart className="size-4 shrink-0 text-amber" aria-hidden="true" />}{assetText(copy, asset)}</span>
                <span className="text-small text-ink-2 tabular-nums">{yearOf(step.ts)}</span>
                {step.proof && <Proof sig={step.proof} copy={copy} mock={mock} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      {hideButton}
    </div>
  );
}

/** The card's title: the full name (or "A family member" / a child's first name). */
export const cardTitle = (at: TreeAtYear, id: PersonId, copy: Copy) => {
  const p = at.people.find((x) => x.id === id);
  return p ? fullLabel(copy, p, at.year) : copy.person.hidden;
};

/** A receipt: Explorer on devnet; in the demo the ids are made up, so plain text marked "simulated". */
function Proof({ sig, copy, mock }: { sig: string; copy: Copy; mock: boolean }) {
  if (mock) {
    return (
      <span className="inline-flex min-h-9 items-center gap-1.5 text-small font-semibold">
        {copy.card.proof}<span className="font-mono font-normal text-ink-2">{shortAddress(sig, 4)}</span><span className="font-normal text-ink-2">({copy.card.simulated})</span>
      </span>
    );
  }
  return (
    <a href={explorerTx(sig)} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-9 items-center gap-1.5 text-small font-semibold text-ink underline decoration-1 underline-offset-4 hover:decoration-2">
      {copy.card.proof}<span className="font-mono font-normal text-ink-2">{shortAddress(sig, 4)}</span><ExternalLink className="size-3.5" aria-hidden="true" /><span className="sr-only">{copy.card.proofSr}</span>
    </a>
  );
}

/** A short sample of a role's line (stroke + dash), for the legend, the cards and the list. */
export function RoleSwatch({ role, className }: { role: string; className?: string }) {
  return (
    <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true" className={`shrink-0 ${className ?? ""}`}>
      <line x1="2" y1="4" x2="24" y2="4" strokeWidth="3" className={`tree-swatch tree-role-${role}`} />
    </svg>
  );
}
