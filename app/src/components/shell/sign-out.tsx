"use client";
/**
 * Sign out, in the account sheet. A Heirloom wallet lives only on this device, so "signing out" is two different things:
 * - Lock: forget the unlocked keys; the next payment asks for the PIN again. Nothing is deleted.
 * - Sign out of this device: delete the wallet from this device. A WDK wallet can only come back with its recovery
 *   phrase, so the person must confirm they have it first. A phone wallet keeps its own keys and can reconnect.
 * In the demo (simulated personas) there is nothing to delete: "Leave the demo" resets the story and goes home.
 */
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, LogOut } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { useWallet } from "@/lib/hooks/wallet-source";
import { useEstate } from "@/lib/hooks/estate";
import { fmt, useCopy } from "./copy";

export function SignOut({ onDone }: { onDone: () => void }) {
  const { common } = useCopy();
  const c = common.persona.signOut;
  const wallet = useWallet();
  const { isMock, resetDemo, notify } = useEstate();
  const router = useRouter();
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  const session = wallet.session;
  if (!session && !isMock) return null;

  const name = session?.label.replace(/\s*\(.*\)$/, "") ?? "";
  const phone = session?.source === "phone";

  const leaveDemo = async () => {
    await resetDemo("fresh");
    notify("info", c.leftDemo);
    onDone();
    router.push("/");
  };

  const lock = () => {
    wallet.lockAll();
    notify("info", c.locked);
    onDone();
  };

  const signOut = () => {
    if (!session) return;
    if (!phone && !saved) { setError(true); document.getElementById(`${id}-saved`)?.focus(); return; }
    const others = wallet.sessions.filter((s) => s.address !== session.address);
    wallet.remove(session.address);
    if (others[0]) wallet.switchTo(others[0].address);
    if (!others.length) {
      // A full reload, not a client navigation: nothing from the removed wallet (keys, a recovery phrase still on
      // screen in an unfinished set-up) may stay in memory.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload is the point here
      window.location.assign("/start");
      return;
    }
    notify("info", fmt(c.done, { name }));
    onDone();
  };

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border border-line bg-surface p-3.5">
      <h3 id={`${id}-title`} className="flex items-center gap-2 font-sans text-body font-semibold tracking-normal">
        <LogOut className="size-4" aria-hidden="true" />{c.title}
      </h3>
      {isMock ? (
        <>
          <p className="mt-1 text-small text-ink-2">{c.demoBody}</p>
          <Button small variant="secondary" className="mt-3" onClick={() => void leaveDemo()}>{c.leaveDemo}</Button>
        </>
      ) : !confirming ? (
        <>
          <p className="mt-1 text-small text-ink-2">{phone ? c.phoneBody : c.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!phone && <Button small variant="secondary" onClick={lock}><Lock className="size-4" aria-hidden="true" />{c.lock}</Button>}
            <Button small variant="secondary" onClick={() => setConfirming(true)}><LogOut className="size-4" aria-hidden="true" />{c.signOut}</Button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-small font-semibold">{fmt(phone ? c.confirmPhone : c.confirm, { name })}</p>
          {!phone && (
            <label className="flex items-start gap-3 text-small">
              <input
                id={`${id}-saved`} type="checkbox" checked={saved} aria-invalid={error || undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(e) => { setSaved(e.target.checked); setError(false); }}
                className="mt-0.5 size-5 shrink-0 accent-[var(--ink)]"
              />
              <span>{c.saved}</span>
            </label>
          )}
          {error && <p id={`${id}-error`} role="alert" className="border-l-4 border-ink pl-2 text-small font-semibold">{c.savedRequired}</p>}
          <div className="flex flex-wrap gap-2">
            <Button small onClick={signOut}>{c.confirmCta}</Button>
            <Button small variant="ghost" onClick={() => { setConfirming(false); setSaved(false); setError(false); }}>{c.cancel}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
