import { handler, json, rateLimit } from "@/lib/api/http";
import { translationInputSchema, translationKeySchema } from "@/lib/legacy/schema";
import { removeTranslation, saveTranslation } from "@/lib/legacy/server/service";
import { authJson } from "@/lib/legacy/server/http";

/**
 * POST /api/legacy/translation { milestoneId, lang, text } → the approved version (plan §20.1 item 4).
 * The owner's own words for one message in another spoken language, approved by the owner: wallet-signed over the
 * exact body, the signer must be the on-chain owner, and only while the estate is Active. The voice then reads these
 * words in that language. Stored with a SHA-256 of the text and of the original it translates.
 */
export const POST = handler(async (req) => {
  rateLimit(req, "legacy-translation-write", 20);
  const { body, viewer } = await authJson(req, "translation.write", translationInputSchema, ["owner"]);
  return json(await saveTranslation(viewer, body));
});

/** DELETE /api/legacy/translation { milestoneId, lang } → the owner removes a version (same rules). */
export const DELETE = handler(async (req) => {
  rateLimit(req, "legacy-translation-delete", 20);
  const { body, viewer } = await authJson(req, "translation.delete", translationKeySchema, ["owner"]);
  await removeTranslation(viewer, body);
  return json({ ok: true });
});
