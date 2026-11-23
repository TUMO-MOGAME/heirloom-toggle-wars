import "server-only";
/**
 * POST /api/letters (app/api/letters/route.ts re-exports it): list, write and delete letters for later
 * (plan.md §16.7). Every call is signed by the acting wallet (ed25519 over lib/letters/canonical.ts letterMessage).
 *
 * Checks, in this order: the body's shape (400 bad_input) and size (413 too_large); the demo deployment
 * (503 unavailable: the demo keeps letters in the browser); the time (401 stale); the signature (401 unauthorized);
 * single use, across instances when the shared store is there (401 replay); the estate from the chain (404). Then:
 *  - list: the owner gets all their letters (tombstones without text), an active beneficiary the open letters they
 *    may read, both the counts; anyone else 403 not_family. Newly open letters are marked opened (sticky).
 *  - write: owner only (403 forbidden), Active only (409 paused / sealed), an open letter is no longer edited
 *    (409 opened), version = stored + 1 (409 version), at most 50 letters (409 full), text ≤ 2,000 after cleaning
 *    (413 too_large), checkLetter (422 bad_letter + field, or 422 bad_link). A payment link records the rule's
 *    spent_total as the baseline. Replay across instances is closed by the version check.
 *  - delete: same owner/status/version checks (an open letter may be deleted); keeps a tombstone without text.
 * Letter text is never logged.
 */
import { createHash } from "node:crypto";
import { handler, HttpError, isChainMode, json, rateLimit } from "@/lib/api/http";
import { verifyEd25519 } from "@/lib/legacy/server/auth";
import { loadSnapshot } from "@/lib/server/estate";
import type { EstateSnapshot } from "@/lib/service/types";
import { defaultPeople } from "@/lib/tree/links";
import { canonicalLetter, cleanInput, deleteBody, LETTER_MAX_SKEW_MS, LIST_BODY, letterMessage, type LetterAction } from "../canonical";
import { canWrite, checkLetter, letterState, linkBaseline, liveLetters, readBaseline } from "../rules";
import { lettersBodySchema } from "../schema";
import { LETTER_MAX_BODY, LETTER_MAX_CHARS, type Letter } from "../types";
import { checkCtx, lettersFor, readCtx, tomb, viewOf } from "../view";
import { seededLetters, withSeeded } from "./demo-letters";
import { getLetters, markOpened, putLetter } from "./store";
import { createNonces } from "@/lib/access/nonces";

export interface LettersRouteDeps {
  chain(): boolean;
  /** Milliseconds. */
  now(): number;
  /** The estate as on chain (status, owner, beneficiaries, rules with spent_total, assets), or null when missing. */
  snapshot(estate: string): Promise<EstateSnapshot | null>;
}

const snapCache = new Map<string, { at: number; snap: Promise<EstateSnapshot | null> }>();
/** Short cache: the list is read on every visit to /letters; a payment shows within 15 s. */
function cachedSnapshot(estate: string): Promise<EstateSnapshot | null> {
  const now = Date.now();
  const hit = snapCache.get(estate);
  if (hit && now - hit.at < 15_000) return hit.snap;
  const snap = loadSnapshot(estate).catch(() => null);
  snapCache.set(estate, { at: now, snap });
  if (snapCache.size > 200) snapCache.delete(snapCache.keys().next().value!);
  return snap;
}
const defaults: LettersRouteDeps = { chain: isChainMode, now: () => Date.now(), snapshot: cachedSnapshot };

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const firstUse = createNonces("letters", LETTER_MAX_SKEW_MS * 2);

/** Parses, then checks time, signature and single use. Shared with the review route. */
export async function readSigned<T extends { estate: string; wallet: string; ts: number; sig: string }>(
  req: Request, parse: (raw: unknown) => T, deps: Pick<LettersRouteDeps, "chain" | "now">, body: (b: T) => { action: LetterAction; text: string },
): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > LETTER_MAX_BODY) throw new HttpError(413, "The letter is too long.", "too_large");
  const raw = await req.text();
  if (raw.length > LETTER_MAX_BODY) throw new HttpError(413, "The letter is too long.", "too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "Body must be JSON.", "bad_input"); }
  let b: T;
  try { b = parse(parsed); } catch { throw new HttpError(400, "That request is not in the expected shape.", "bad_input"); }
  if (!deps.chain()) throw new HttpError(503, "The demo keeps letters in the browser.", "unavailable");
  const now = deps.now();
  if (Math.abs(now - b.ts) > LETTER_MAX_SKEW_MS) throw new HttpError(401, "This request is too old. Please try again.", "stale");
  const { action, text } = body(b);
  if (!verifyEd25519(b.wallet, letterMessage(action, b.estate, b.wallet, b.ts, sha(text)), b.sig)) throw new HttpError(401, "The signature does not match this wallet.", "unauthorized");
  if (!(await firstUse(b.sig, now))) throw new HttpError(401, "This request was already used. Please try again.", "replay");
  return b;
}

/** Who may have a transcribed letter: someone without a wallet, or someone the estate's family records as passed. */
export function transcribable(estate: string, today: number) {
  return (person: string) => person.startsWith("local:") || defaultPeople(estate).some((p) => p.id === person && p.passed !== undefined && p.passed <= today);
}

const REFUSED = {
  forbidden: [403, "Only the estate owner can write letters."],
  paused: [409, "Letters can't be changed while a passing is being confirmed."],
  sealed: [409, "Letters are sealed now that the estate has unlocked."],
  opened: [409, "This letter has opened, so it can no longer be changed."],
  version: [409, "This letter was changed somewhere else. Reload and try again."],
  full: [409, "An estate can keep 50 letters. Delete one to write another."],
} as const;

export function lettersRoutes(deps: LettersRouteDeps = defaults) {
  const POST = handler(async (req) => {
    rateLimit(req, "letters", 60);
    const b = await readSigned(req, (raw) => lettersBodySchema.parse(raw), deps, (x) => ({
      action: x.action,
      text: x.action === "list" ? LIST_BODY : x.action === "delete" ? deleteBody(x.id, x.version) : canonicalLetter(x.estate, x.wallet, x.letter, x.version),
    }));
    if (b.action !== "list") rateLimit(req, "letters-write", 30);

    const snap = await deps.snapshot(b.estate);
    if (!snap) throw new HttpError(404, "Estate not found on-chain.", "not_found");
    const now = deps.now();
    const nowS = Math.floor(now / 1000);
    const stored = await getLetters(b.estate);
    const all = withSeeded(stored, await seededLetters(b.estate, snap));
    const ctx = readCtx(snap, now);

    if (b.action === "list") {
      // Mark newly open letters (stored rows only; seeded ones open by their own condition).
      for (const l of stored) {
        if (l.openedAt === null && !l.deleted && letterState(l, ctx) === "open") { l.openedAt = viewOf(l, snap, ctx).openedAt; await markOpened(b.estate, l.id, l.openedAt!); }
      }
      const view = lettersFor(withSeeded(stored, await seededLetters(b.estate, snap)), snap, b.wallet, now);
      if (!view) throw new HttpError(403, "Only the estate's family can read letters.", "not_family");
      return json(view);
    }

    const id = b.action === "write" ? b.letter.id : b.id;
    const existing = all.find((l) => l.id === id) ?? null;
    const row = stored.find((l) => l.id === id);
    const why = canWrite({
      actor: b.wallet, owner: snap.estate.owner, status: snap.estate.status, existing,
      existingOpen: !!existing && !existing.deleted && letterState(existing, ctx) === "open",
      version: b.version, liveCount: liveLetters(all).length, action: b.action,
    });
    if (why) throw new HttpError(REFUSED[why][0], REFUSED[why][1], why);

    if (b.action === "delete") {
      const gone: Letter = { ...tomb(existing!), version: b.version, hash: sha(deleteBody(id, b.version)), sig: b.sig, signedAt: b.ts, updatedAt: nowS };
      if (!(await putLetter(gone, row?.version ?? 0))) throw new HttpError(409, REFUSED.version[1], "version");
      return json({ ok: true });
    }

    const input = cleanInput(b.letter);
    if ([...input.text].length > LETTER_MAX_CHARS) throw new HttpError(413, "The letter is longer than 2,000 characters.", "too_large");
    const problem = checkLetter(input, checkCtx(snap, now, transcribable(b.estate, new Date(now).getUTCFullYear())));
    if (problem?.code === "link") throw new HttpError(422, "That payment rule is not for this person.", "bad_link");
    if (problem) return json({ error: "Something in the letter needs fixing.", code: "bad_letter", field: problem.field, problem: problem.code }, { status: 422 });
    // A send-to-family link needs a server check of the transfer (plan.md §16.14 step 9, not built yet).
    if (input.opens.kind === "send") throw new HttpError(422, "That transfer could not be checked.", "bad_link");

    let baseline: string | undefined;
    if (input.opens.kind === "payment") {
      const rule = input.opens.rule;
      const now = snap.rules.find((r) => r.address === rule);
      // Kept only while the slot still holds the same rule: a reused slot starts its own count (letters/rules.ts).
      const keep = existing && !existing.deleted && existing.opens.kind === "payment" && existing.opens.rule === rule
        && existing.baseline && readBaseline(existing.baseline).generation === readBaseline(linkBaseline(now)).generation
        ? existing.baseline : undefined;
      baseline = keep ?? linkBaseline(now);
    }
    const letter: Letter = {
      ...input, estate: b.estate, from: b.wallet, version: b.version, hash: sha(canonicalLetter(b.estate, b.wallet, input, b.version)),
      sig: b.sig, signedAt: b.ts, createdAt: existing && !existing.deleted ? existing.createdAt : nowS, updatedAt: nowS, openedAt: null,
      ...(baseline !== undefined ? { baseline } : {}),
    };
    if (!(await putLetter(letter, row?.version ?? 0))) throw new HttpError(409, REFUSED.version[1], "version");
    return json({ letter: viewOf(letter, snap, ctx) });
  });

  return { POST };
}
