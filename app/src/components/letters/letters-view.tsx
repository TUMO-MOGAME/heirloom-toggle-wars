"use client";
/**
 * Letters for later (loaded with next/dynamic only on /letters). The owner writes, edits and deletes letters while
 * the estate is active; a family member reads the letters that have opened for them. The rules are the shared ones
 * (lib/letters), so the demo and devnet behave the same; the service decides who may see what.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { CloudOff, Info, Lock, Mail, Plus } from "@/components/ui/icons";
import { Button, EmptyState, LoadingCards, Notice } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/client";
import { useEstate } from "@/lib/hooks/estate";
import { useLocale } from "@/lib/i18n/client";
import type { EstateSnapshot } from "@/lib/service";
import type { Role } from "@/lib/types";
import type { LetterView, LettersView as View } from "@/lib/letters/types";
import { letterErrorKey } from "@/lib/letters/errors";
import { browserStorage, markSeen } from "@/lib/letters/device";
import { LetterList } from "./letter-list";
import { LetterCard } from "./letter-card";
import { fill, letterWords, type Copy } from "./words";
import { shortName } from "@/lib/names";

// The editor (form, review, "Help me write it") loads only when the owner opens it.
const LetterEditor = dynamic(() => import("./letter-editor").then((m) => m.LetterEditor), { ssr: false });

export default function LettersView({ copy, snap, role, viewer }: { copy: Copy; snap: EstateSnapshot; role: Role; viewer: string }) {
  const { service, notify, isMock } = useEstate();
  const locale = useLocale();
  const estate = snap.estate.address;
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<LetterView | "new" | null>(null);
  const [reading, setReading] = useState<LetterView | null>(null);
  const [deleting, setDeleting] = useState<LetterView | null>(null);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState<string | null>(null);
  const owner = role === "owner";

  // Reload when the estate changes in a way that can open a letter: its status or a payment under a rule.
  const spentKey = snap.rules.map((r) => `${r.address}:${r.spentTotal}`).join(",");
  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!service) return;
    let live = true;
    service.listLetters(estate)
      .then((v) => { if (live) { setView(v); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [service, estate, snap.estate.status, spentKey, viewer, nonce]);

  // Letters a family member has seen here stop showing as "a letter for you" on the other screens.
  const mine = useMemo(() => (view?.letters ?? []).filter((l) => !l.deleted), [view]);
  useEffect(() => {
    if (owner || !mine.length) return;
    markSeen(browserStorage(), mine.filter((l) => l.state === "open").map((l) => l.id));
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [owner, mine]);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done, { once: true });
    window.print();
    return () => window.removeEventListener("afterprint", done);
  }, [printing]);

  const remove = async () => {
    if (!service || !deleting) return;
    setBusy(true);
    try {
      await service.deleteLetter(estate, deleting.id, deleting.version + 1);
      notify("ok", copy.list.deleted);
      setDeleting(null);
      load();
    } catch (e) {
      notify("error", copy.errors[(letterErrorKey(e) ?? "network") as keyof Copy["errors"]]);
    } finally { setBusy(false); }
  };

  if (!view) {
    if (failed) return <EmptyState icon={<CloudOff className="size-6" aria-hidden="true" />} title={copy.loadError} action={<Button onClick={() => void load()}>{copy.retry}</Button>} />;
    return <LoadingCards label={copy.loading} />;
  }

  const footer = (
    <footer className="grid gap-2 border-t border-line pt-4 print-hide">
      <p className="text-small text-ink-2">{copy.notWill}</p>
      <Link href="/privacy#letters" className="inline-flex min-h-11 items-center text-small font-semibold text-ink underline underline-offset-4">{copy.privacy}</Link>
    </footer>
  );

  if (!owner) {
    return (
      <div className="grid gap-5 *:min-w-0">
        <h2 className="text-h3 print-hide">{copy.read.title}</h2>
        {mine.length === 0 ? (
          <EmptyState icon={<Mail className="size-6" aria-hidden="true" />} title={copy.read.empty} />
        ) : (
          <div className="grid gap-5">
            {mine.map((l) => (
              <div key={l.id} className={printing && printing !== l.id ? "print-hide" : undefined}>
                <LetterCard letter={l} snap={snap} copy={copy} locale={locale} mock={isMock} onPrint={() => setPrinting(l.id)} />
              </div>
            ))}
          </div>
        )}
        {footer}
      </div>
    );
  }

  const locked = view.sealed || view.paused;
  return (
    <div className="grid gap-5 *:min-w-0">
      <Notice tone={isMock ? "warn" : "accent"} icon={<Info className="size-5" aria-hidden="true" />}>{isMock ? copy.demoNote : fill(copy.chainNote, { owner: shortName(snap.estate.ownerName) || snap.estate.ownerName })}</Notice>
      {locked && <Notice icon={<Lock className="size-5" aria-hidden="true" />}>{view.sealed ? copy.sealed : copy.paused}</Notice>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-h3">{copy.list.title}</h2>
        {!locked && <Button onClick={() => setEditing("new")}><Plus className="size-5" aria-hidden="true" />{copy.list.new}</Button>}
      </div>
      <LetterList
        letters={mine} snap={snap} copy={copy} locale={locale} locked={locked}
        onRead={setReading} onEdit={setEditing} onDelete={setDeleting}
      />
      {footer}

      {editing && (
        <LetterEditor
          copy={copy} snap={snap} locale={locale} letter={editing === "new" ? null : editing}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); load(); }}
        />
      )}
      <Sheet open={!!reading} onClose={() => setReading(null)} title={copy.read.title} closeLabel={copy.editor.cancel}>
        {reading && <LetterCard letter={reading} snap={snap} copy={copy} locale={locale} mock={isMock} />}
      </Sheet>
      <Sheet
        open={!!deleting} onClose={() => setDeleting(null)} title={copy.list.confirmTitle} description={copy.list.confirmDelete} closeLabel={copy.list.cancel}
        footer={(
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{copy.list.cancel}</Button>
            <Button loading={busy} onClick={() => void remove()}>{copy.list.confirmCta}</Button>
          </div>
        )}
      >
        {deleting && <p className="font-semibold">{letterWords(deleting, copy).occasion || copy.list.untitled}</p>}
      </Sheet>
    </div>
  );
}
