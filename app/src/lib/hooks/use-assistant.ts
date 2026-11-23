"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantCopy } from "@/content/assistant";
import { useEstate } from "./estate";
import type { AssistantMessage } from "./agent-types";
import { useLocale } from "@/lib/i18n/client";
import { shortName } from "../names";

// The chat pipeline (intent parsing, its zod schemas, the mock orchestrator) loads on the first message, not with the
// agent sheet, which every page mounts (closed) once it has settled.
const pipeline = () => import("../chat/pipeline");

/** General assistant chat. Mock mode answers on-device; chain mode calls the orchestrator and falls back on-device. */
export function useAssistant(copy: AssistantCopy, page: string) {
  const { isMock, service, snap, fx, session, role } = useEstate();
  const locale = useLocale();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [pending, setPending] = useState(false);
  const id = useRef(0);
  const ctx = useRef({ snap, fx, session, role, page, isMock, locale, service });
  useEffect(() => { ctx.current = { snap, fx, session, role, page, isMock, locale, service }; });

  const name = session ? shortName(session.label) : "";
  // Roles without their own greeting (agent, and monitor until content/assistant.ts has one) get the general one.
  const greetKey = role && role !== "agent" && role in copy.greeting ? (role as keyof typeof copy.greeting) : "none";
  const greeting = copy.greeting[greetKey].replace("{name}", name);
  const person = session?.address ?? "none";

  useEffect(() => {
    // A fresh conversation whenever the acting person changes.
    setMessages([{ id: ++id.current, role: "agent", text: greeting, specialist: "EstateGuide" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const history = messages;
    setMessages((m) => [...m.map((x) => ({ ...x, fresh: false })), { id: ++id.current, role: "user", text: trimmed }]);
    setPending(true);
    const c = ctx.current;
    const { runAssistantTurn, turnText } = await pipeline();
    const result = await runAssistantTurn(trimmed, history, c, copy);
    const final = result.reply;
    setMessages((m) => [...m, {
      id: ++id.current, role: "agent", fresh: true, specialist: final.specialist, actions: final.actions,
      text: turnText(result, copy),
    }]);
    setPending(false);
  }, [messages, copy]);

  const reset = useCallback(() => {
    setMessages([{ id: ++id.current, role: "agent", text: greeting, specialist: "EstateGuide" }]);
  }, [greeting]);

  return { messages, pending, send, reset };
}
