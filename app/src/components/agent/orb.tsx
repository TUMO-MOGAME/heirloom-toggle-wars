"use client";
import clsx from "clsx";
import { m as motion, useReducedMotion } from "motion/react";
import { MotionScope } from "@/components/ui/motion-provider";
import type { HeirloomVoice } from "@/lib/voice/types";

/** The call view's voice orb: rings and bars that spring with the sound level. Loaded with the call view (agent-sheet). */
export function Orb(props: { voice: HeirloomVoice; label: string }) {
  return <MotionScope><OrbBody {...props} /></MotionScope>;
}

function OrbBody({ voice, label }: { voice: HeirloomVoice; label: string }) {
  const reduced = useReducedMotion();
  const connected = voice.status === "connected";
  const waiting = voice.status === "connecting" || voice.status === "requesting-mic";
  const out = connected ? voice.outputLevel : 0;
  const inp = connected && !voice.muted ? voice.inputLevel : 0;
  const level = Math.max(out, inp);
  const userTalking = inp > out && inp > 0.08;
  const spring = { type: "spring" as const, stiffness: 260, damping: 18, mass: 0.6 };
  // The orb is drawn in ink only: three outlined rings that swell with the sound level, around a core
  // that is hollow (outlined) while Heirloom listens and solid while it speaks. Five bars show the level.
  const bars = [0.45, 0.8, 1, 0.8, 0.45];
  return (
    <div className="relative mx-auto grid size-56 place-items-center" role="img" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          aria-hidden="true"
          className="absolute rounded-full border border-ink"
          style={{ inset: `${i * 1.1}rem`, borderWidth: i === 2 ? 2 : 1, borderStyle: waiting ? "dashed" : "solid" }}
          animate={reduced ? { opacity: level > 0.08 ? 1 : 0.45 } : { scale: 1 + level * (0.16 - i * 0.04), opacity: 0.25 + i * 0.2 + level * 0.4 }}
          transition={spring}
        />
      ))}
      <motion.span
        aria-hidden="true"
        className={clsx(
          "relative grid size-28 place-items-center rounded-full border-2 border-ink transition-colors duration-200",
          voice.isSpeaking && !userTalking ? "bg-ink text-bg" : "bg-surface text-ink",
          (waiting || (connected && level < 0.05)) && !reduced && "animate-[orb-breathe_2.6s_ease-in-out_infinite]",
        )}
        animate={reduced ? {} : { scale: 1 + (voice.isSpeaking ? out : inp) * 0.14 }}
        transition={spring}
      >
        <span className="flex h-12 items-center gap-1.5">
          {bars.map((w, i) => (
            <motion.span
              key={i}
              className="w-1.5 rounded-full bg-current"
              animate={{ height: reduced ? (level > 0.08 ? 8 + w * 22 : 8) : 6 + level * w * 42 }}
              transition={spring}
            />
          ))}
        </span>
      </motion.span>
    </div>
  );
}
