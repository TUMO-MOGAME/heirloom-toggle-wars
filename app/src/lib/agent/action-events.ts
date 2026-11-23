/**
 * The browser side of agent UI intents (./actions.ts), without zod: the app shell listens on every page, and
 * the schema library is only fetched when an action actually arrives. Every action is still validated.
 */
import type { UiAction } from "./actions";

/** Browser event name carrying a UiAction in `detail`. */
export const AGENT_ACTION_EVENT = "heirloom:agent-action";

export function dispatchAgentAction(action: UiAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<UiAction>(AGENT_ACTION_EVENT, { detail: action }));
}

/** Subscribe to agent UI intents (validated against uiActionSchema). Returns an unsubscribe function. */
export function onAgentAction(handler: (action: UiAction) => void): () => void {
  let live = true;
  const fn = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    void import("./actions").then(({ uiActionSchema }) => {
      const parsed = uiActionSchema.safeParse(detail);
      if (live && parsed.success) handler(parsed.data);
    });
  };
  window.addEventListener(AGENT_ACTION_EVENT, fn);
  return () => { live = false; window.removeEventListener(AGENT_ACTION_EVENT, fn); };
}
