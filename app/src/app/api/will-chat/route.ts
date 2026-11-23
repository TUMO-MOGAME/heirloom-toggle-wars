import { dailyCap, handler, json, parseJson, rateLimitShared } from "@/lib/api/http";
import { willChatBody } from "@/lib/agent/schemas";
import { orchestrate } from "@/lib/agent/orchestrator";

export const maxDuration = 60;

/** POST /api/will-chat { history, locale? } → { reply, draft } via the WillWriter specialist. */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "will-chat", 20);
  const { history, locale } = await parseJson(req, willChatBody);
  await dailyCap(req, "model");
  const r = await orchestrate({ history, facts: null, context: { role: "owner", locale } }, "WillWriter");
  return json({ reply: r.reply, draft: r.draft ?? null, specialist: r.specialist });
});
