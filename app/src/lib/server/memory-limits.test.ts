/**
 * Plan §18.9 M6: the in-memory stores (no Supabase) evicted globally, so one family's notes or letters pushed out
 * another's (2,000 notes; 200 estates of letters). Now each family has its own limit, nobody is pushed out for anyone
 * else, and memory stays bounded: past a store's limit a newcomer is refused instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));

const asks = await import("../ask/server/store");
const letters = await import("../letters/server/store");
const db = await import("../db");
const { storeEvidence } = await import("../storage");
import type { Letter } from "../letters/types";
import type { AgentReport } from "../types";

const note = (estate: string, claim: string, createdAt: number) =>
  ({ estate, claim, purpose: "Books", currency: "USDT" as const, typed: 1, attachment: false, createdAt, declinedAt: null });
const letter = (estate: string, id: string, deleted = false): Letter => ({
  id, estate, from: "O", to: { kind: "family" }, opens: { kind: "unlock" }, occasion: "", text: deleted ? "" : "x",
  version: 1, hash: "h", sig: null, signedAt: 1, createdAt: 1, updatedAt: Number(id.replace(/\D/g, "")) || 1, openedAt: null,
  ...(deleted ? { deleted: true as const } : {}),
});
const report: AgentReport = { verdict: "approve", documentType: "x", extracted: {}, redFlags: [], confidence: 1, summary: "", reportHash: "" };

beforeEach(() => { asks.resetAskMemory(); letters.resetLettersMemory(); });

describe("request notes", () => {
  it("a family at its limit lets go of its own oldest note, never another family's", async () => {
    await asks.saveAsk(note("theirs", "their-claim", 1));
    for (let i = 0; i < asks.MAX_PER_ESTATE + 50; i++) await asks.saveAsk(note("mine", `c${i}`, 10 + i));
    expect(await asks.listAsks("theirs")).toHaveLength(1);
    expect(await asks.listAsks("mine")).toHaveLength(asks.MAX_PER_ESTATE);
  });

  it("keeps a decline over an undeclined note when it has to let one go", async () => {
    await asks.declineAsk("mine", "declined", 5, 0);
    for (let i = 0; i < asks.MAX_PER_ESTATE + 5; i++) await asks.saveAsk(note("mine", `c${i}`, 10 + i));
    expect((await asks.getAsk("declined"))?.declinedAt).toBe(5);
  });

  it("a full store refuses a new family rather than pushing one out", async () => {
    for (let e = 0; e < 100; e++) for (let i = 0; i < asks.MAX_PER_ESTATE; i++) await asks.saveAsk(note(`e${e}`, `e${e}c${i}`, i));
    await expect(asks.saveAsk(note("newcomer", "n", 1))).rejects.toMatchObject({ status: 503, code: "storage_full" });
    expect(await asks.listAsks("e0")).toHaveLength(asks.MAX_PER_ESTATE);
  });
});

describe("letters for later", () => {
  it("a new family is refused when the store is full; no family's letters are dropped", async () => {
    for (let e = 0; e < letters.MAX_ESTATES; e++) await letters.putLetter(letter(`e${e}`, "l1"), 0);
    await expect(letters.putLetter(letter("newcomer", "l1"), 0)).rejects.toMatchObject({ code: "storage_full" });
    expect(await letters.getLetters("e0")).toHaveLength(1);
  });

  it("a family at its limit lets go of its oldest deleted letter only", async () => {
    for (let i = 0; i < letters.MAX_PER_ESTATE - 1; i++) await letters.putLetter(letter("mine", `t${i + 1}`, true), 0);
    await letters.putLetter(letter("mine", "live1"), 0);
    await letters.putLetter(letter("mine", "new2"), 0);
    const ids = (await letters.getLetters("mine")).map((l) => l.id);
    expect(ids).toContain("live1");
    expect(ids).not.toContain("t1");
  });
});

describe("agent reports and files", () => {
  it("a family's reports are its own: another family's many never push them out", async () => {
    await db.saveReport({ reportHash: "theirs", purpose: "claim", estate: "theirs", subject: null, evidencePath: null, evidenceSha256: null, report, txSignature: null });
    for (let i = 0; i < db.MAX_MEM_REPORTS_PER_ESTATE + 20; i++) {
      await db.saveReport({ reportHash: `m${i}`, purpose: "claim", estate: "mine", subject: null, evidencePath: null, evidenceSha256: null, report, txSignature: null });
    }
    expect(Object.keys(await db.getReports(["theirs"], "theirs"))).toEqual(["theirs"]);
  });

  it("an evidence file is not kept in memory at all", async () => {
    const stored = await storeEvidence(new TextEncoder().encode("%PDF-1.4 x"), "application/pdf", "claim");
    expect(stored.backend).toBe("none");
  });
});
