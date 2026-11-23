"use client";
import { useCallback, useRef, useState } from "react";
import { HeartHandshake, Lock, Mail, Power } from "@/components/ui/icons";
import type { LegacyCopy, LegacySafetyCopy } from "@/content/legacy";
import type { EstateSnapshot } from "@/lib/service";
import { useEstate } from "@/lib/hooks/estate";
import { GUIDANCE_TOPICS, isStandin, milestonesFor, pronouns, type LegacySpeech, type LegacyStatus } from "@/lib/legacy/rules";
import { Button, ButtonLink, Card, EmptyState, Notice } from "@/components/ui/primitives";
import { fmt } from "@/components/shell/copy";
import { DisclosureLabel, PlayButton, SafetyCard } from "./parts";
import { useLegacyPlayer } from "./use-player";
import { legacyError } from "./use-legacy";
import { shortName } from "@/lib/names";

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" });

/**
 * A child's Legacy Voice page. After unlock, and only if they opt in, they hear the messages their parent wrote
 * while alive, in the parent's voice. There is no chat and no call: the voice never says new words (plan §16.17).
 */
export function ChildTalk({ copy, safety, status, snap, reload }: { copy: LegacyCopy; safety: LegacySafetyCopy; status: LegacyStatus; snap: EstateSnapshot; reload: () => Promise<void> }) {
  const c = copy.child;
  const { service, notify } = useEstate();
  const book = status.book;
  const called = book?.calledBy ?? "Dad";
  const p = pronouns(book?.pronoun ?? "he");
  const vars = { called, calledLower: called.toLowerCase(), pronoun: p.subject, possessive: p.possessive };
  const [busy, setBusy] = useState(false);

  // No Legacy Book: a clear empty state. A book without a cloned voice is read by the labelled stand-in voice.
  if (!status.book) {
    return <EmptyState icon={<HeartHandshake className="size-6" aria-hidden="true" />} title={fmt(c.noBook, vars)} body={fmt(c.noBookBody, vars)}
      action={<ButtonLink href="/letters" variant="secondary"><Mail className="size-4" aria-hidden="true" />{c.lettersCta}</ButtonLink>} />;
  }
  const standin = isStandin(status.voice);
  if (!status.unlocked) {
    return (
      <Notice tone="neutral" icon={<Lock className="size-5" aria-hidden="true" />} title={fmt(c.locked, vars)}>
        <ButtonLink href="/family" small variant="secondary" className="mt-3">{copy.eyebrow}</ButtonLink>
      </Notice>
    );
  }
  if (!status.optedIn) {
    const choose = async () => {
      if (!service) return;
      setBusy(true);
      try { await service.setLegacyOptIn(snap.estate.address, true); await reload(); }
      catch (e) { notify("error", legacyError(e, c.error)); }
      finally { setBusy(false); }
    };
    return (
      <Card className="border-2 border-ink">
        <h2 className="flex items-center gap-2 text-h3"><HeartHandshake className="size-5" aria-hidden="true" />{fmt(standin ? c.optIn.titleStandin : c.optIn.title, vars)}</h2>
        <p className="mt-2">{fmt(standin ? c.optIn.bodyStandin : c.optIn.body, vars)}</p>
        <DisclosureLabel className="mt-3" text={fmt(c.label, { called, date: status.voice ? fmtDate(status.voice.consentedAt) : "" })} simulated={standin} simulatedText={c.labelSimulated} />
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button loading={busy} onClick={() => void choose()}>{c.optIn.yes}</Button>
          <ButtonLink href="/family" variant="ghost">{c.optIn.notNow}</ButtonLink>
        </div>
      </Card>
    );
  }
  return <Messages copy={copy} safety={safety} status={status} snap={snap} reload={reload} />;
}

function Messages({ copy, safety, status, snap, reload }: { copy: LegacyCopy; safety: LegacySafetyCopy; status: LegacyStatus; snap: EstateSnapshot; reload: () => Promise<void> }) {
  const c = copy.child;
  const { service, notify } = useEstate();
  const book = status.book!;
  const voiceInfo = status.voice;
  const standin = isStandin(voiceInfo);
  const called = book.calledBy;
  const p = pronouns(book.pronoun);
  const vars = { called, calledLower: called.toLowerCase(), pronoun: p.subject, possessive: p.possessive };
  const estate = snap.estate.address;
  const { play, stop, playing } = useLegacyPlayer();
  const disclosed = useRef(false);
  const [showHelp, setShowHelp] = useState(false);
  const ms = milestonesFor(book, status.childId);
  const kid = book.children.find((k) => k.id === status.childId) ?? null;
  const adults = snap.estate.verifierNames.map(shortName).join(", ");

  /**
   * The disclosure is spoken (in Heirloom's own ElevenLabs voice) before the first message plays in the parent's
   * voice. If it can't play, the written disclosure label on screen still says it.
   */
  const say = useCallback(async (id: string, s: LegacySpeech) => {
    if (!disclosed.current && service) {
      disclosed.current = true;
      await service.legacySpeak(estate, { disclosure: true }).then((d) => play("disclosure", d)).catch(() => undefined);
    }
    await play(id, s);
  }, [play, service, estate]);

  const playMilestone = async (id: string) => {
    if (!service) return;
    try { await say(id, await service.legacySpeak(estate, { milestoneId: id })); }
    catch (e) { notify("error", legacyError(e, c.error)); }
  };

  const switchOff = async () => {
    if (!service) return;
    stop();
    try { await service.setLegacyOptIn(estate, false); notify("info", c.optIn.offDone); await reload(); }
    catch (e) { notify("error", legacyError(e, c.error)); }
  };

  // The owner's other words, to read (never voiced): the child's note, values, lessons, sayings and guidance.
  const guidance = GUIDANCE_TOPICS
    .map((t) => ({ t, text: [kid?.guidance[t], book.guidance[t]].filter(Boolean).join(" ") }))
    .filter((g) => g.text);
  const lists = ([["values", book.values], ["lessons", book.lessons], ["phrases", book.phrases]] as const).filter(([, xs]) => xs.length > 0);
  const hasWords = Boolean(kid?.note) || guidance.length > 0 || lists.length > 0;

  return (
    <div className="grid gap-5">
      <div className="sticky top-[calc(var(--header-h,3.5rem)+0.25rem)] z-10 -mx-1 rounded-full bg-surface/90 px-1 py-1 backdrop-blur-sm">
        <DisclosureLabel text={fmt(c.label, { called, date: voiceInfo ? fmtDate(voiceInfo.consentedAt) : "" })} simulated={standin} simulatedText={c.labelSimulated} />
      </div>

      <Card>
        <h2 className="text-h3">{fmt(c.messages, vars)}</h2>
        {ms.length === 0 ? <p className="mt-2 text-ink-2">{fmt(c.noMessages, vars)}</p> : (
          <ul className="mt-3 grid gap-2">
            {ms.map((m) => (
              <li key={m.id} className="flex items-center gap-3 rounded-md border border-line p-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{m.title}</span>
                  <span className="block text-small text-ink-2">{copy.owner.book.kinds[m.kind]}</span>
                </span>
                <PlayButton small playing={playing === m.id} onPlay={() => void playMilestone(m.id)} onStop={stop} label={c.play} stopLabel={c.stopPlaying} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {hasWords && (
        <Card>
          <h2 className="text-h3">{fmt(c.words, vars)}</h2>
          <p className="mt-1 text-small text-ink-2">{fmt(c.wordsBody, vars)}</p>
          <dl className="mt-3 grid gap-3">
            {kid?.note && <div><dt className="font-semibold">{c.note}</dt><dd className="mt-0.5">{kid.note}</dd></div>}
            {lists.map(([key, xs]) => (
              <div key={key}>
                <dt className="font-semibold">{fmt(c[key], vars)}</dt>
                <dd><ul className="mt-0.5 grid list-disc gap-0.5 pl-5">{xs.map((x) => <li key={x}>{x}</li>)}</ul></dd>
              </div>
            ))}
            {guidance.length > 0 && (
              <div>
                <dt className="font-semibold">{fmt(c.guidance, vars)}</dt>
                <dd><ul className="mt-0.5 grid gap-1.5">{guidance.map((g) => <li key={g.t}><span className="font-medium">{copy.owner.book.topics[g.t]}:</span> {g.text}</li>)}</ul></dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      <div className="grid gap-3">
        <Button variant="secondary" className="justify-self-start" aria-expanded={showHelp} onClick={() => setShowHelp((x) => !x)}>
          <HeartHandshake className="size-4" aria-hidden="true" />{showHelp ? safety.close : safety.open}
        </Button>
        {showHelp && <SafetyCard copy={safety} called={called} adults={adults} />}
      </div>

      <Button variant="ghost" className="justify-self-start" onClick={() => void switchOff()}><Power className="size-4" aria-hidden="true" />{c.optIn.off}</Button>
    </div>
  );
}
