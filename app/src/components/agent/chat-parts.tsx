"use client";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowRight, ArrowUp, Sparkles } from "@/components/ui/icons";
import type { AssistantCopy } from "@/content/assistant";
import type { SpecialistName } from "@/lib/voice/types";
import { mapAgentPath, type AgentAction } from "@/lib/hooks/agent-types";
import { onAgentAction } from "@/lib/agent/action-events";
import { useEstate } from "@/lib/hooks/estate";
import { shortAddress } from "@/lib/format";
import { usePay } from "@/components/pay/payment";
import { LogoMark } from "@/components/ui/primitives";
import { Typewriter } from "@/components/ui/client";
import { fmt } from "@/components/shell/copy";
import { appendTranscript, useMicButton } from "./mic-button";

/** Small chip naming which specialist answered. */
export function SpecialistChip({ name, copy }: { name: SpecialistName; copy: AssistantCopy }) {
  return (
    <span className="inline-flex min-h-6 items-center gap-1 rounded-full border border-line-strong bg-surface px-2 text-[0.75rem] font-semibold text-ink">
      <Sparkles className="size-3" aria-hidden="true" />
      <span className="sr-only">{copy.specialistHint} </span>
      {copy.specialists[name] ?? name}
    </span>
  );
}

export function Bubble({
  role, text, specialist, fresh = false, copy, children, onTick, onTyped, enter = "motion",
}: {
  role: "user" | "agent"; text: string; specialist?: SpecialistName; fresh?: boolean; copy: AssistantCopy;
  children?: ReactNode; onTick?: () => void; onTyped?: () => void;
  /**
   * How an agent message arrives: "motion" (default) and "css" both fade in with the CSS `bubble-in` (no animation
   * library, so a server-rendered opening message shows before any JavaScript runs); "none": it is already on screen.
   */
  enter?: "motion" | "css" | "none";
}) {
  const [typed, setTyped] = useState(!fresh);
  if (role === "user") {
    return (
      <li className="bubble-in flex justify-end">
        <p className="max-w-[85%] whitespace-pre-line rounded-[1.25rem] rounded-br-md bg-ink px-4 py-2.5 text-bg">
          <span className="sr-only">{copy.chat.you}: </span>{text}
        </p>
      </li>
    );
  }
  const body = (
    <>
      <LogoMark className="mt-6 size-7 shrink-0" />
      <div className="min-w-0 max-w-[88%]">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-small font-semibold">{copy.chat.agent}</span>
          {specialist && specialist !== "Orchestrator" && <SpecialistChip name={specialist} copy={copy} />}
        </div>
        <div className="rounded-[1.25rem] rounded-tl-md border border-line-strong bg-surface px-4 py-2.5">
          <Typewriter text={text} active={fresh} onTick={onTick} onDone={() => { setTyped(true); onTyped?.(); }} />
        </div>
        {typed && children}
      </div>
    </>
  );
  return <li className={clsx("flex items-start gap-2.5", enter !== "none" && "bubble-in")}>{body}</li>;
}

export function Thinking({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <LogoMark className="size-7 shrink-0" />
      <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-2 animate-pulse-soft rounded-full bg-ink" style={{ animationDelay: `${i * 180}ms` }} aria-hidden="true" />
        ))}
        <span className="sr-only">{label}</span>
      </span>
    </li>
  );
}

export function Chips({ items, onPick, label, disabled }: { items: readonly string[]; onPick: (s: string) => void; label: string; disabled?: boolean }) {
  if (!items.length) return null;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {items.map((s) => (
        <button
          key={s} type="button" disabled={disabled} onClick={() => onPick(s)}
          className="min-h-11 rounded-[1.375rem] border border-ink bg-surface px-4 py-2.5 text-left text-small font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function Composer({ onSend, disabled, copy, autoFocus }: { onSend: (text: string) => void; disabled?: boolean; copy: { placeholder: string; inputLabel: string; send: string }; autoFocus?: boolean }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  // Voice typing: the words are added to the box to check and send; never sent by voice.
  const heard = useCallback((text: string) => {
    setValue((v) => appendTranscript(v, text));
    const el = ref.current;
    if (el) { el.focus(); window.requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length)); }
  }, []);
  const mic = useMicButton({ onText: heard, statusClassName: "px-4 pt-1.5" });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!value.trim() || disabled) return;
    onSend(value);
    setValue("");
    ref.current?.focus();
  };
  return (
    <div className="min-w-0">
      <form onSubmit={submit} className="flex items-end gap-2 rounded-[1.5rem] border border-line-strong bg-surface p-1.5 pl-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus)]">
        <label htmlFor={fieldId} className="sr-only">{copy.inputLabel}</label>
        <textarea
          id={fieldId} ref={ref} rows={1} value={value} autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={copy.placeholder}
          className="max-h-32 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-body outline-none placeholder:text-ink-2 [field-sizing:content]"
        />
        {mic.button}
        <button type="submit" disabled={disabled || !value.trim()} aria-label={copy.send} className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-bg transition-opacity disabled:opacity-40">
          <ArrowUp className="size-5" aria-hidden="true" />
        </button>
      </form>
      {mic.status}
    </div>
  );
}

/** Performs an agent UI action: used by the buttons under a reply and by intents the agent emits itself (voice tools). */
export function usePerformAction() {
  const router = useRouter();
  const { setIntent, setProofOpen, service, explain, notify } = useEstate();
  const { pay } = usePay();
  return useCallback((x: AgentAction) => {
    if (x.type === "reviewSend") {
      if (!service) return;
      router.push(x.bill ? "/bill" : "/send");
      service.reviewSend({ to: x.to, toLabel: x.toLabel, amountUsdt: x.amountUsdt, ...(x.bill ? { bill: x.bill } : {}) })
        .then((r) => pay({ kind: r.kind, to: r.to, toLabel: r.toLabel, amount: r.amount, review: r }))
        .catch((e: unknown) => notify("error", explain(e).message));
      return;
    }
    if (x.type === "navigate") {
      const to = mapAgentPath(x.to);
      if (to.includes("proof=1")) setProofOpen(true);
      router.push(to.split("?proof=1")[0]);
    } else if (x.type === "openClaimForm") { setIntent({ kind: "claim", rule: x.rule, payee: x.payee, amount: x.amount }); router.push("/claims"); }
    else if (x.type === "showRule") { setIntent({ kind: "rule", rule: x.rule }); router.push("/estate"); }
    else { setIntent({ kind: "upload", purpose: x.purpose }); router.push(x.purpose === "death" ? "/family" : x.purpose === "claim" ? "/claims" : "/hardship"); }
  }, [router, setIntent, setProofOpen, service, pay, explain, notify]);
}

/** Listens for UI intents emitted by the agent (text orchestrator or voice client tools). Renders nothing. */
export function AgentActionBridge() {
  const perform = usePerformAction();
  useEffect(() => onAgentAction((a) => perform(a.type === "navigate" ? { type: "navigate", to: a.path } : a)), [perform]);
  return null;
}

/** Turns orchestrator actions into buttons and performs them. */
export function ActionButtons({ actions, copy, onDone }: { actions: AgentAction[]; copy: AssistantCopy; onDone?: () => void }) {
  const run = usePerformAction();
  const { role } = useEstate();
  if (!actions.length) return null;
  const a = copy.actions;
  const label = (x: AgentAction) =>
    x.type === "navigate" ? fmt(a.navigate, { page: a.pages[x.to.split("?")[0]] ?? a.fallbackPage })
      : x.type === "openClaimForm" ? a.openClaimForm
        : x.type === "showRule" ? a.showRule
          : x.type === "reviewSend" ? fmt(x.bill ? a.reviewBill : a.reviewSend, { name: x.toLabel.split(" · ")[0] || shortAddress(x.to) })
          : x.purpose === "death" ? a.startUploadDeath : x.purpose === "claim" ? a.startUploadClaim : a.startUploadHardship;
  const perform = (x: AgentAction) => { run(x); onDone?.(); };
  const visible = actions.filter((x) => !(x.type === "openClaimForm" && role !== "beneficiary"));
  return (
    <div role="group" aria-label={copy.chat.actionsLabel} className="mt-2 flex flex-wrap gap-2">
      {visible.map((x, i) => (
        <button
          key={i} type="button" onClick={() => perform(x)}
          className={clsx("inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-small font-semibold", i === 0 ? "border border-ink bg-ink text-bg hover:bg-ink-hover" : "border border-ink bg-surface hover:bg-surface-2")}
        >
          {label(x)} <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
