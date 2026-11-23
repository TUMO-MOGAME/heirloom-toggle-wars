/**
 * UI intents the agent (text orchestrator or voice) can ask the app to perform. Client-safe.
 * The UI listens with `onAgentAction()`; voice client tools and /api/agent/orchestrate both emit these.
 */
import { z } from "zod";

export const uiActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), path: z.string().regex(/^\/[\w\-/[\]?=&.%]*$/).max(200) }),
  z.object({
    type: z.literal("openClaimForm"),
    rule: z.string().max(64).optional(),
    payee: z.string().max(64).optional(),
    amount: z.number().nonnegative().max(100_000_000).optional(),
  }),
  z.object({ type: z.literal("showRule"), rule: z.string().max(64) }),
  z.object({ type: z.literal("startUpload"), purpose: z.enum(["death", "claim", "hardship"]) }),
]);

export type UiAction = z.infer<typeof uiActionSchema>;

// The browser event helpers live in ./action-events (no zod, so the shell stays light); re-exported here.
export { AGENT_ACTION_EVENT, dispatchAgentAction, onAgentAction } from "./action-events";
