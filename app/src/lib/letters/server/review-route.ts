import "server-only";
/**
 * POST /api/letters/review (app/api/letters/review/route.ts re-exports it): "Check my letter" and "Help me write it"
 * (plan.md §16.6). Owner only, Active only, signed like /api/letters (the signed body is the canonical JSON of the
 * draft or the input). The deterministic review always runs and the AI can only add to it; without a key, or on any
 * AI error, the answer is the rules' warnings (source "rules") or the template (source "template"). Letter text is
 * never stored or logged here.
 */
import { handler, HttpError, isChainMode, json, rateLimitShared } from "@/lib/api/http";
import { canonicalJson } from "@/lib/agent/hash";
import { aiReviewLetter, aiSuggestLetter, lettersAiAvailable } from "@/lib/agent/letters";
import { getUsdtZar } from "@/lib/fx";
import { letters as copy } from "@/content/letters";
import { shortName } from "@/lib/names";
import { cleanInput } from "../canonical";
import { mergeReview, reviewDraft } from "../review";
import { reviewBodySchema } from "../schema";
import { fillTemplate } from "../template";
import type { LetterReview, LetterSuggestion } from "../types";
import { planFacts, reviewCtxFor } from "../view";
import { readSigned, type LettersRouteDeps } from "./route";
import { loadSnapshot } from "@/lib/server/estate";

export interface ReviewRouteDeps extends LettersRouteDeps {
  ai(): boolean;
  usdtZar(): Promise<number>;
}
const defaults: ReviewRouteDeps = {
  chain: isChainMode, now: () => Date.now(), snapshot: (e) => loadSnapshot(e).catch(() => null),
  ai: lettersAiAvailable, usdtZar: async () => (await getUsdtZar()).usdtZar,
};

export function reviewRoutes(deps: ReviewRouteDeps = defaults) {
  const POST = handler(async (req) => {
    await rateLimitShared(req, "letters-review", 10);
    const b = await readSigned(req, (raw) => reviewBodySchema.parse(raw), deps, (x) => ({
      action: x.action, text: canonicalJson(x.action === "review" ? x.draft : x.input),
    }));
    const snap = await deps.snapshot(b.estate);
    if (!snap) throw new HttpError(404, "Estate not found on-chain.", "not_found");
    if (snap.estate.owner !== b.wallet) throw new HttpError(403, "Only the estate owner can write letters.", "forbidden");
    if (snap.estate.status === "DeathPending") throw new HttpError(409, "Letters can't be changed while a passing is being confirmed.", "paused");
    if (snap.estate.status !== "Active") throw new HttpError(409, "Letters are sealed now that the estate has unlocked.", "sealed");

    if (b.action === "review") {
      const draft = cleanInput(b.draft);
      const ctx = reviewCtxFor(snap, draft, await deps.usdtZar().catch(() => 17.5));
      const rules = await reviewDraft(draft.text, ctx);
      if (!deps.ai()) return json({ warnings: rules, source: "rules" } satisfies LetterReview);
      try {
        const ai = await aiReviewLetter({ text: draft.text, occasion: draft.occasion, recipient: ctx.recipientName, plan: planFacts(snap) }, b.locale);
        return json({ warnings: mergeReview(rules, ai), source: "rules+ai" } satisfies LetterReview);
      } catch {
        return json({ warnings: rules, source: "rules" } satisfies LetterReview);
      }
    }

    const to = b.input.to;
    const label = to.kind === "family" ? "" : snap.beneficiaries.find((x) => x.wallet === to.wallet)?.label ?? "";
    const name = to.kind === "family" ? "" : shortName(label.replace(/\s*\(.*\)$/, ""));
    const template = (): LetterSuggestion => ({ text: fillTemplate(copy.help.templates, b.input.occasion.trim() ? "date" : "unlock", name || copy.list.family, b.input.occasion), source: "template" });
    if (!deps.ai()) return json(template());
    try {
      const text = await aiSuggestLetter({ name: name || "the whole family", occasion: b.input.occasion, points: b.input.points, opens: "later" }, b.locale);
      return json({ text, source: "ai" } satisfies LetterSuggestion);
    } catch {
      return json(template());
    }
  });
  return { POST };
}
