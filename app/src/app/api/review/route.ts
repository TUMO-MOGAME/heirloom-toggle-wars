import { PublicKey } from "@solana/web3.js";
import { dailyCap, handler, HttpError, isChainMode, json, rateLimitShared } from "@/lib/api/http";
import { reviewFields } from "@/lib/agent/schemas";
import { reviewDocument } from "@/lib/agent/review";
import { loadReviewTarget } from "@/lib/agent/review-target";
import { MAX_UPLOAD_BYTES, storeEvidence, validateUpload } from "@/lib/storage";
import { recordEvidence, saveReport } from "@/lib/db";
import { sha256Hex } from "@/lib/agent/hash";
import { agentAddress, agentSignAndSend, hasAgentWallet } from "@/lib/agent/agent-wallet";
import { spendAgentAllowance } from "@/lib/agent/budget";
import { refusedByProgram } from "@/lib/agent/refusal";
import { assertServedEstate, verifyAction } from "@/lib/access/server";
import { actionBody } from "@/lib/access/messages";
import { outcomeOf, type ReviewOutcome } from "@/lib/verdict";
import { DeadlineError, withDeadline } from "@/lib/server/deadline";
import { assertProgram } from "@/lib/server/program";

export const maxDuration = 90;
/** The model has until this long after the request arrived (its retries included), the recording until SEND_BY_MS. */
const MODEL_MS = 50_000;
const SEND_BY_MS = 85_000;

/**
 * POST /api/review (multipart: file, purpose=death|claim|hardship|seat-death|fallback-death, estate, context, subject?,
 * index?, preview?=1).
 *
 * A preview (and everything in mock mode) only reads the document: nothing is stored, recorded or signed.
 * A real review, in this order:
 * 1. the request is signed by a wallet over exactly this file and target (lib/access);
 * 2. the chain says the file is the evidence submitted, that wallet submitted it, it is not reviewed yet, and the
 *    estate is one this agent serves. Only then is the file stored and the model called;
 * 3. the reviewer gets facts built from the chain. The caller's `context` is passed only as untrusted text;
 * 4. the agent signs approve, reject or refer. An unsure agent never approves: death, claim and hardship go to
 *    people with a higher quorum; seat and fallback deaths, which have no such step, are rejected. Death reviews
 *    carry the hash of this file: if another report replaced it meanwhile the program refuses (409 ReportChanged).
 * Returns { report, evidence: { sha256 }, tx: { signature, explorerUrl } | null, onChain: string }.
 */
export const POST = handler(async (req) => {
  const started = Date.now();
  await rateLimitShared(req, "review", 30);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64_000) throw new HttpError(413, "The file is larger than 4 MB.", "too_large");
  const form = await req.formData().catch(() => { throw new HttpError(400, "Expected a form upload with the document as `file`."); });
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Attach the document as `file`.");
  const fields = reviewFields.parse({
    purpose: form.get("purpose"), estate: form.get("estate"), context: form.get("context") ?? "", subject: form.get("subject") ?? undefined,
    index: form.get("index") ?? undefined,
  });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = validateUpload(bytes, file.type);
  const sha256 = await sha256Hex(bytes);
  const read = { bytes, mime, purpose: fields.purpose, untrusted: fields.context, evidenceSha256: sha256 };

  const chain = isChainMode();
  const preview = form.get("preview") === "1";
  if (preview || !chain) {
    await dailyCap(req, "model"); // anyone may ask for a preview: it is held to the day's free use
    const report = await reviewDocument({ ...read, deadline: started + MODEL_MS });
    return json({ report, evidence: { sha256, storage: "none" }, tx: null, onChain: preview ? "skipped (preview)" : "skipped (mock mode)" });
  }

  const { purpose, estate, subject, index } = fields;
  const wallet = await verifyAction(req, "review", estate, actionBody.review({ purpose, subject, index, sha256 }));
  if (!hasAgentWallet()) throw new HttpError(503, "The agent wallet is not configured.", "unavailable");
  await assertProgram(); // before the model is paid for a review that could not be recorded
  const agent = await agentAddress();
  const target = await loadReviewTarget({ purpose, estate, subject, index, sha256 });
  if (target.submitter !== wallet) throw new HttpError(403, "Only the person who submitted this can ask for its review.", "forbidden");
  assertServedEstate(target.estate, agent);
  await spendAgentAllowance("review", wallet, estate);

  const ref = [purpose, estate, subject ?? "", index ?? "", sha256].join("|");
  const report = await reviewDocument({ ...read, facts: target.facts, deadline: started + MODEL_MS, ref });
  let outcome: ReviewOutcome | null = outcomeOf(report.verdict);
  // No one to refer a seat or fallback death to, so an unsure review rejects (a clearer certificate can be sent), unless
  // the person has no name on record and the review found nothing wrong: then it was unsure only because the name
  // could not be checked, which people check later. Nothing is signed and the review can be asked for again (H12).
  const nameOnly = target.unnamed && report.redFlags.length === 0 && report.confidence >= 0.6;
  if (outcome === "Refer" && !target.canRefer) outcome = nameOnly ? null : "Reject";

  // A trusted person's or fallback recipient's certificate is stored and logged as a death certificate.
  const storePurpose: "death" | "claim" | "hardship" = purpose === "seat-death" || purpose === "fallback-death" ? "death" : purpose;
  const stored = await storeEvidence(bytes, mime, storePurpose);
  await recordEvidence(stored.path, stored.sha256, storePurpose, stored.mime, stored.size);
  const evidence = { sha256, storage: stored.backend };
  // Saved before anything is sent: the on-chain hash must always lead to the report, even if the answer is lost (M2).
  const row = {
    reportHash: report.reportHash, purpose: storePurpose, estate, subject: subject ?? null,
    evidencePath: stored.path, evidenceSha256: stored.sha256, report, txSignature: null as string | null,
  };
  if (!(await saveReport(row))) throw new HttpError(503, "The review could not be saved, so nothing was recorded. Please try again.", "busy", 30);
  if (outcome === null) {
    return json({ report, evidence, tx: null, onChain: "agent could not decide from the document alone: nothing was recorded; ask for the review again or send a clearer certificate" });
  }

  const tx = await withDeadline(agentSignAndSend([target.instruction(new PublicKey(agent!), outcome, report.reportHash)]), started + SEND_BY_MS - Date.now(), "Recording the review")
    .catch((e: unknown) => {
      if (e instanceof DeadlineError) throw new HttpError(504, "The review is saved and was sent, but its confirmation did not arrive in time. Reload in a minute to see it.", "unconfirmed");
      return refusedByProgram(e);
    });
  await saveReport({ ...row, txSignature: tx.signature });

  const onChain = outcome === "Reject" ? "agent rejected on-chain"
    : outcome === "Refer" ? "agent was not sure: referred on-chain to people, who need a higher quorum"
      : purpose === "fallback-death" ? "agent approved on-chain; after the wait a second person confirms, unless the recipient says they are alive"
        : "agent approved on-chain; waiting for human verifiers";
  return json({ report, evidence, tx, onChain });
});
