/**
 * Letters for later on the live network (chain mode, plan.md §16.5), loaded with import() from chain.ts like
 * chain-tree. Nothing goes on-chain: every call is a signed POST to /api/letters (or /api/letters/review) with the
 * active wallet, and the server reads the estate's status, owner, beneficiaries and rules from the chain.
 *
 * - The owner's own letters are also kept on this device (lib/letters/device.ts), so without a server store (503) or
 *   offline they can still see and edit them; merged with the server's by version.
 * - Recipients keep no letter text on the device, only the ids they have seen (for the "you have a letter" card).
 * - Without the server, the review falls back to the deterministic rules and "Help me write it" to the template.
 */
import type { Base58 } from "../types";
import type { EstateSnapshot } from "./types";
import type { Locale } from "../i18n/locales";
import { letters as copy } from "@/content/letters";
import { canonicalJson, sha256Hex } from "../agent/hash";
import { canonicalLetter, cleanInput, deleteBody, LIST_BODY, letterMessage, type LetterAction } from "../letters/canonical";
import { canWrite, checkLetter, letterState, linkBaseline, liveLetters } from "../letters/rules";
import { reviewDraft } from "../letters/review";
import { fillTemplate } from "../letters/template";
import { LetterError, type LetterErrorCode } from "../letters/errors";
import { browserStorage, keepOnDevice, mergeLetters, readDeviceLetters } from "../letters/device";
import { checkCtx, readCtx, reviewCtxFor, tomb, viewOf } from "../letters/view";
import type { Letter, LetterInput, LetterReview, LettersService, LettersView, LetterSuggestion, LetterView } from "../letters/types";
import { shortName } from "../names";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export interface ChainLettersDeps {
  getEstate(estate: Base58): Promise<EstateSnapshot>;
  signer(): { address: Base58; signMessage(message: string): Promise<string>; canSignQuietly?(): boolean };
  usdtZar?(): Promise<number>;
  fetch?: typeof fetch;
  /** null = no device storage. */
  storage?: Storage | null;
  /** Milliseconds. */
  now?(): number;
}

/** The server answered, or why not: "offline" (network, or no server store: 503) keeps this device's copy standing. */
type Answer<T> = { ok: true; data: T } | { ok: false; offline: true } | { ok: false; offline: false; error: LetterError };

const CODES: LetterErrorCode[] = ["forbidden", "paused", "sealed", "opened", "version", "too_large", "bad_letter", "bad_link", "full", "unavailable", "network", "not_family"];

export function createChainLetters(d: ChainLettersDeps): LettersService {
  const f = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const storage = d.storage === undefined ? browserStorage() : d.storage;
  const now = d.now ?? (() => Date.now());

  async function call<T>(path: string, action: LetterAction, estate: Base58, bodyText: string, fields: Record<string, unknown>): Promise<Answer<T>> {
    const signer = d.signer();
    const ts = now();
    const sig = await signer.signMessage(letterMessage(action, estate, signer.address, ts, await sha256Hex(bodyText)));
    let res: Response;
    try {
      res = await f(path, {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, estate, wallet: signer.address, ts, sig, ...fields }),
      });
    } catch {
      return { ok: false, offline: true };
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; field?: string };
    if (res.ok) return { ok: true, data: data as T };
    if (res.status === 503 || res.status >= 500) return { ok: false, offline: true };
    const code = (CODES as string[]).includes(data.code ?? "") ? (data.code as LetterErrorCode) : "bad_letter";
    return { ok: false, offline: false, error: new LetterError(code, data.error ?? `Request failed (${res.status})`, data.field) };
  }

  const me = () => d.signer().address;
  const device = (estate: Base58) => readDeviceLetters(storage, estate, me());

  async function localView(estate: Base58): Promise<{ snap: EstateSnapshot; view: (l: Letter) => LetterView }> {
    const snap = await d.getEstate(estate);
    const ctx = readCtx(snap, now());
    return { snap, view: (l) => viewOf(l.deleted ? tomb(l) : l, snap, ctx) };
  }

  async function listLetters(estate: Base58, opts: { quiet?: boolean } = {}): Promise<LettersView> {
    // A background read never asks for a PIN: if the wallet is locked, answer from this device, as when offline.
    const quietSkip = opts.quiet && d.signer().canSignQuietly?.() === false;
    const r: Answer<LettersView> = quietSkip ? { ok: false, offline: true } : await call<LettersView>("/api/letters", "list", estate, LIST_BODY, {});
    if (!r.ok && !r.offline) throw r.error;
    const mine = device(estate);
    if (r.ok) {
      if (!mine.length) return r.data;
      const { view } = await localView(estate);
      return { ...r.data, letters: mergeLetters(r.data.letters, mine, view) };
    }
    // No server: the owner's own letters from this device; a recipient sees nothing until the server is back.
    const { snap, view } = await localView(estate);
    const st = snap.estate.status;
    return { letters: snap.estate.owner === me() ? mine.map(view) : [], counts: [], sealed: st === "Unlocked" || st === "Frozen", paused: st === "DeathPending" };
  }

  /** The same checks as the server, for a save that can only be kept on this device. */
  function checkLocally(snap: EstateSnapshot, input: LetterInput, version: number, action: "write" | "delete", existing: Letter | null) {
    const ctx = readCtx(snap, now());
    const why = canWrite({
      actor: me(), owner: snap.estate.owner, status: snap.estate.status, existing,
      existingOpen: !!existing && !existing.deleted && letterState(existing, ctx) === "open",
      version, liveCount: liveLetters(device(snap.estate.address)).length, action,
    });
    if (why) throw new LetterError(why, copy.errors[why]);
    if (action === "delete") return;
    const problem = checkLetter(input, checkCtx(snap, now(), (p) => p.startsWith("local:")));
    if (problem) throw new LetterError(problem.code === "link" ? "bad_link" : "bad_letter", copy.errors.badLetter, problem.field);
  }

  return {
    listLetters,

    async saveLetter(estate, raw, version) {
      const input = cleanInput(raw);
      if ([...input.text].length > 2000) throw new LetterError("too_large", copy.errors.tooLarge, "text");
      const r = await call<{ letter: LetterView }>("/api/letters", "write", estate, canonicalLetter(estate, me(), input, version), { letter: input, version });
      if (r.ok) { keepOnDevice(storage, r.data.letter); return r.data.letter; }
      if (!r.offline) throw r.error;
      // Kept on this device until the server can take it (the page says so).
      const { snap, view } = await localView(estate);
      const existing = device(estate).find((l) => l.id === input.id) ?? null;
      checkLocally(snap, input, version, "write", existing);
      const nowS = Math.floor(now() / 1000);
      const o = input.opens;
      const letter: Letter = {
        ...input, estate, from: me(), version, hash: await sha256Hex(canonicalLetter(estate, me(), input, version)), sig: null,
        signedAt: now(), createdAt: existing?.createdAt ?? nowS, updatedAt: nowS, openedAt: null,
        ...(o.kind === "payment" ? { baseline: linkBaseline(snap.rules.find((x) => x.address === o.rule)) } : {}),
      };
      if (!keepOnDevice(storage, letter)) throw new LetterError("unavailable", copy.errors.unavailable);
      return view(letter);
    },

    async deleteLetter(estate, id, version) {
      const r = await call<{ ok: true }>("/api/letters", "delete", estate, deleteBody(id, version), { id, version });
      const existing = device(estate).find((l) => l.id === id);
      if (r.ok) { if (existing) keepOnDevice(storage, { ...tomb(existing), version }); return; }
      if (!r.offline) throw r.error;
      if (!existing) throw new LetterError("unavailable", copy.errors.unavailable);
      const { snap } = await localView(estate);
      checkLocally(snap, existing, version, "delete", existing);
      keepOnDevice(storage, { ...tomb(existing), version, updatedAt: Math.floor(now() / 1000) });
    },

    async reviewLetter(estate, raw, locale: Locale): Promise<LetterReview> {
      const draft = cleanInput(raw);
      const r = await call<LetterReview>("/api/letters/review", "review", estate, canonicalJson(draft), { draft, locale });
      if (r.ok) return r.data;
      if (!r.offline) throw r.error;
      const snap = await d.getEstate(estate);
      const fx = await (d.usdtZar?.() ?? Promise.resolve(17.5)).catch(() => 17.5);
      return { warnings: await reviewDraft(draft.text, reviewCtxFor(snap, draft, fx)), source: "rules" };
    },

    async suggestLetter(estate, input, locale: Locale): Promise<LetterSuggestion> {
      const r = await call<LetterSuggestion>("/api/letters/review", "suggest", estate, canonicalJson(input), { input, locale });
      if (r.ok) return r.data;
      if (!r.offline) throw r.error;
      const snap = await d.getEstate(estate);
      const label = input.to.kind === "person" ? snap.beneficiaries.find((b) => b.wallet === (input.to as { wallet: Base58 }).wallet)?.label ?? "" : "";
      const name = label ? shortName(label.replace(/\s*\(.*\)$/, "")) : copy.list.family;
      return { text: fillTemplate(copy.help.templates, input.occasion.trim() ? "date" : "unlock", name, input.occasion), source: "template" };
    },

    async letterCounts(estate) {
      try { return (await listLetters(estate, { quiet: true })).counts; } catch { return []; }
    },
  };
}
