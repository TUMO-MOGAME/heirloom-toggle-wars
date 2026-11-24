import { dailyCap, handler, json, rateLimitShared } from "@/lib/api/http";
import { translationKeySchema } from "@/lib/legacy/schema";
import { suggestTranslation } from "@/lib/legacy/server/service";
import { authJson } from "@/lib/legacy/server/http";

export const maxDuration = 30;

/**
 * POST /api/legacy/translation/suggest { milestoneId, lang } → { text }: a faithful machine translation (Gemini) of
 * the owner's own saved message. Owner only, wallet-signed, estate Active. Nothing is stored and nothing is voiced:
 * the owner must read, edit and approve the words (POST /api/legacy/translation) before the voice can say them.
 * The body names a message, never text, so this is not a general translation service.
 * Limits: 10/min per IP, and the shared daily cap on model calls.
 */
export const POST = handler(async (req) => {
  await rateLimitShared(req, "legacy-translation-suggest", 10);
  const { body, viewer } = await authJson(req, "translation.suggest", translationKeySchema, ["owner"]);
  await dailyCap(req, "model");
  return json(await suggestTranslation(viewer, body));
});
