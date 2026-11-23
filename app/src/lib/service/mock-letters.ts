/**
 * Letters for later in the demo (mock mode, plan.md §16.5), loaded with import() on first use like mock-tree.
 *
 * - The rules are the shared ones (lib/letters/rules.ts, view.ts), so the demo answers like /api/letters. Reading
 *   follows the signed-in persona; everything is in one browser, so this demonstrates the rule rather than enforcing
 *   it (the page says "Demo: letters stay in this browser").
 * - The story letters (lib/letters/demo.ts) are added on first use after each demo reset; a deleted one stays a
 *   tombstone. Naledi's letter opens with her 500 USD₮ birthday gift rule (seeded by mock.ts), so "Pay now" on that
 *   rule, or any payment under a rule a letter is linked to, opens it: the rule's spentTotal goes up.
 * - Review and "Help me write it" are deterministic here (no AI in the demo).
 * - letterCounts adds the story's imagined openings for the Trust Tree: L1 and L2 when Thabo passes (2041, or the year
 *   the visitor played it), Naledi's in 2029, and Lerato's letter to Amahle when Lerato passes in 2086.
 */
import type { Base58 } from "../types";
import type { EstateSnapshot } from "./types";
import { letters as copy } from "@/content/letters";
import { canonicalLetter, cleanInput } from "../letters/canonical";
import { sha256Hex } from "../agent/hash";
import { canWrite, checkLetter, letterState, linkBaseline, liveLetters, readBaseline, sastYear, visibleCounts } from "../letters/rules";
import { reviewDraft } from "../letters/review";
import { fillTemplate } from "../letters/template";
import { demoLetters, DEMO_LETTER_IDS, NALEDI_BIRTHDAY } from "../letters/demo";
import { LetterError } from "../letters/errors";
import { checkCtx, lettersFor, readCtx, reviewCtxFor, tomb, viewOf } from "../letters/view";
import type { Letter, LetterCount, LetterInput, LettersService, LettersView } from "../letters/types";
import { toBase } from "../format";
import { shortName } from "../names";

/** Lerato's own plan and her daughter in the Trust Tree story (same as lib/service/mock-tree.ts; checked by a test). */
export const STORY_LERATO_ESTATE = "EsTaTe2LeRaToMoKoEnAvAuLt7xQp5sZc3FdYg8uE6rB";
export const STORY_AMAHLE_WALLET = "AmAhLeMoKoEnAgRaNdDaUgHtEr5sZc3FdYg8uE6rAo1";
/** When Lerato passes in the story (her letter to Amahle opens). */
export const STORY_LERATO_PASSES = 2086;

export interface MockLettersState {
  byId: Record<string, Letter>;
  /** The estate the story letters were added to (after a demo reset they are added again). */
  seeded?: Base58;
}

export interface MockLettersDeps {
  /** The demo estate, or null before a plan is signed. */
  snap(): EstateSnapshot | null;
  /** The signed-in persona (throws when none). */
  me(): Base58;
  /** Unix seconds. */
  now(): number;
  wait(ms: number): Promise<void>;
  save(): void;
  state(): MockLettersState;
  /** A confirmed send-to-family transfer, by signature. */
  sendConfirmed(signature: string): boolean;
  cast: { lerato: Base58; naledi: Base58 };
  usdtZar: number;
}

const fail = (code: ConstructorParameters<typeof LetterError>[0], message: string, field?: string): never => { throw new LetterError(code, message, field); };

/** Naledi's 500 USD₮ birthday gift rule (mock.ts seed). */
export function giftRuleOf(snap: EstateSnapshot, naledi: Base58): Base58 | undefined {
  return snap.rules.find((r) => r.beneficiary === naledi && r.recurringAmount === toBase(500) && r.fixedPayee === naledi)?.address;
}

/** When Thabo passes in the story: the year the visitor played it, or 2041. */
export function storyPassingYear(snap: EstateSnapshot, nowS: number): number {
  return snap.estate.status === "Unlocked" || snap.estate.status === "DeathPending" ? sastYear(nowS * 1000) : 2041;
}

export function createMockLetters(d: MockLettersDeps): LettersService & { stored(): Letter[] } {
  const need = () => d.snap() ?? fail("forbidden", "There is no estate yet. The owner signs the plan first.");
  const nowMs = () => d.now() * 1000;

  /** The story letters, added once per demo estate (a deleted one stays a tombstone). */
  async function ensure(snap: EstateSnapshot) {
    const st = d.state();
    if (st.seeded === snap.estate.address) return;
    const gift = giftRuleOf(snap, d.cast.naledi);
    const seeded = await demoLetters({
      estate: snap.estate.address, owner: snap.estate.owner, lerato: d.cast.lerato, naledi: d.cast.naledi,
      corolla: snap.assets.find((a) => /corolla/i.test(a.title))?.address,
      giftRule: gift, giftBaseline: gift ? linkBaseline(snap.rules.find((r) => r.address === gift)) : undefined,
    });
    for (const l of seeded) if (!st.byId[l.id]) st.byId[l.id] = l;
    st.seeded = snap.estate.address;
    d.save();
  }

  const all = () => Object.values(d.state().byId);

  /** Marks open letters as opened (sticky), so a letter that opened at unlock stays open. */
  function markOpened(snap: EstateSnapshot) {
    const ctx = readCtx(snap, nowMs(), d.sendConfirmed);
    let changed = false;
    for (const l of all()) {
      if (l.openedAt === null && !l.deleted && letterState(l, ctx) === "open") { l.openedAt = viewOf(l, snap, ctx).openedAt; changed = true; }
    }
    if (changed) d.save();
  }

  async function load(): Promise<{ snap: EstateSnapshot; view: LettersView }> {
    const snap = need();
    await ensure(snap);
    markOpened(snap);
    const view = lettersFor(all(), snap, d.me(), nowMs(), d.sendConfirmed) ?? fail("not_family", "Only the estate's family can read letters.");
    return { snap, view };
  }

  function writable(snap: EstateSnapshot, id: string, version: number, action: "write" | "delete") {
    const existing = d.state().byId[id] ?? null;
    const ctx = readCtx(snap, nowMs(), d.sendConfirmed);
    const why = canWrite({
      actor: d.me(), owner: snap.estate.owner, status: snap.estate.status, existing,
      existingOpen: !!existing && !existing.deleted && letterState(existing, ctx) === "open",
      version, liveCount: liveLetters(all()).length, action,
    });
    if (why) fail(why, copy.errors[why]);
    return { existing, ctx };
  }

  return {
    stored: all,

    async listLetters() {
      await d.wait(250);
      return structuredClone((await load()).view);
    },

    async saveLetter(_estate, raw: LetterInput, version) {
      await d.wait(700);
      const snap = need();
      await ensure(snap);
      const { existing, ctx } = writable(snap, raw.id, version, "write");
      const input = cleanInput(raw);
      if ([...input.text].length > 2000) fail("too_large", copy.errors.tooLarge, "text");
      const problem = checkLetter(input, checkCtx(snap, nowMs(), (p) => p.startsWith("local:")));
      if (problem?.code === "link" || input.opens.kind === "send") fail("bad_link", copy.errors.badLink, "opens");
      if (problem) fail("bad_letter", copy.errors.badLetter, problem.field);
      const from = d.me();
      const live = existing && !existing.deleted ? existing : null;
      const o = input.opens;
      const baseline = o.kind === "payment"
        ? (live?.opens.kind === "payment" && live.opens.rule === o.rule && live.baseline && readBaseline(live.baseline).generation === ((snap.rules.find((r) => r.address === o.rule)?.claimCount ?? 0) >>> 16)
          ? live.baseline : linkBaseline(snap.rules.find((r) => r.address === o.rule)))
        : undefined;
      const nowS = d.now();
      const letter: Letter = {
        ...input, estate: snap.estate.address, from, version, hash: await sha256Hex(canonicalLetter(snap.estate.address, from, input, version)),
        // The demo has no real wallet signature; a made-up one stands in, like the demo's transaction ids.
        sig: `demo-${version}`, signedAt: nowMs(), createdAt: live?.createdAt ?? nowS, updatedAt: nowS, openedAt: null,
        ...(baseline !== undefined ? { baseline } : {}),
      };
      d.state().byId[letter.id] = letter;
      d.save();
      return structuredClone(viewOf(letter, snap, ctx));
    },

    async deleteLetter(_estate, id, version) {
      await d.wait(500);
      const snap = need();
      await ensure(snap);
      const { existing } = writable(snap, id, version, "delete");
      d.state().byId[id] = { ...tomb(existing!), version, updatedAt: d.now(), signedAt: nowMs(), sig: `demo-${version}` };
      d.save();
    },

    async reviewLetter(_estate, draft: LetterInput) {
      await d.wait(600);
      const snap = need();
      if (d.me() !== snap.estate.owner) fail("forbidden", copy.errors.forbidden);
      const input = cleanInput(draft);
      return { warnings: await reviewDraft(input.text, reviewCtxFor(snap, input, d.usdtZar)), source: "rules" as const };
    },

    async suggestLetter(_estate, input) {
      await d.wait(500);
      const snap = need();
      if (d.me() !== snap.estate.owner) fail("forbidden", copy.errors.forbidden);
      const to = input.to;
      const label = to.kind === "person" ? snap.beneficiaries.find((b) => b.wallet === to.wallet)?.label ?? "" : "";
      const name = label ? shortName(label.replace(/\s*\(.*\)$/, "")) : copy.list.family;
      return { text: fillTemplate(copy.help.templates, input.occasion.trim() ? "date" : "unlock", name, input.occasion), source: "template" as const };
    },

    async letterCounts() {
      await d.wait(150);
      const snap = need();
      await ensure(snap);
      markOpened(snap);
      const ctx = readCtx(snap, nowMs(), d.sendConfirmed);
      const real = visibleCounts(all(), ctx);
      const today = sastYear(nowMs());
      const P = storyPassingYear(snap, d.now());
      const byId = d.state().byId;
      const story: LetterCount[] = [];
      const imagine = (id: string, year: number, count: LetterCount) => {
        const l = byId[id];
        if (!l || l.deleted || letterState(l, ctx) === "open" || year <= today) return;
        story.push({ ...count, year, imagined: true });
      };
      const owner = snap.estate.owner;
      imagine(DEMO_LETTER_IDS.family, P, { from: owner, to: "family", year: P });
      imagine(DEMO_LETTER_IDS.lerato, P, { from: owner, to: d.cast.lerato, year: P });
      imagine(DEMO_LETTER_IDS.naledi, Number(NALEDI_BIRTHDAY.slice(0, 4)), { from: owner, to: d.cast.naledi, year: 2029 });
      // L4: Lerato's letter to Amahle, in Lerato's own plan. No text: the tree only counts it.
      story.push({ from: d.cast.lerato, to: STORY_AMAHLE_WALLET, year: STORY_LERATO_PASSES, imagined: true });
      return [...real, ...story];
    },
  };
}
