/** Letters for later: the opening, reading, writing and checking rules (plan.md §16.4), and the canonical form. */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { canWrite, canRead, checkLetter, letterState, linkBaseline, opensAt, sastDay, visibleCounts, type CheckCtx, type OpenCtx, type WriteCtx } from "./rules";
import { canonicalLetter, cleanLetterText, cleanOccasion, deleteBody, letterHash, letterMessage, newLetterId } from "./canonical";
import { LETTER_ID, type Letter, type LetterInput } from "./types";

const OWNER = "4uQxH9yp9bajHRuR2rNuiTedsJ9DcrDqCZzpXc6Fu96Y";
const LERATO = "FXb3FikjwrPU8nR8WjJB6y4LCZ1esdw3vkUybPwMvGZZ";
const SIPHO = "BMiTCRtWEettDpHQvL9kBt5bkSpiNeAMZYwYUmaAybbV";
const NALEDI = "7MC44yaTaRQCxW3aSnzfr2deQzWw3yvw4XnrmpUewirD";
const BUYER = "12eMQwGSR57E2wKRt8Uwn18DWaN54GKY7HGJD8zTLaV8";
const RULE = "8NCbN1YkHje1m4twHXYhWoaaHjbNVwqqwePNyc6Ag21t";
const CAR = "DqMKvrGcZbWhwPYG6iPuij3o365tWa18JEnBjjrTVo16";
const E = "J6WCQvgkJmzYQXjo37GLktZnFB9nbpwCchkCVKbcKMaj";
const NOW = Date.UTC(2026, 10, 18, 10);

const letter = (over: Partial<Letter> = {}): Letter => ({
  id: "ltr_AAAAAAAAAAAAAAAA", to: { kind: "person", wallet: LERATO }, opens: { kind: "unlock" }, occasion: "", text: "Hello",
  estate: E, from: OWNER, version: 1, hash: "0".repeat(64), sig: null, signedAt: NOW, createdAt: NOW / 1000, updatedAt: NOW / 1000, openedAt: null, ...over,
});
const ctx = (over: Partial<OpenCtx & { activeBeneficiaries: string[] }> = {}) => ({
  status: "Active" as const, nowMs: NOW, ruleSpent: () => 0n, sendConfirmed: () => false, activeBeneficiaries: [LERATO, SIPHO, NALEDI], ...over,
});

describe("opensAt", () => {
  it("is midnight in South Africa (22:00 UTC the day before)", () => {
    expect(new Date(opensAt("2029-08-14")).toISOString()).toBe("2029-08-13T22:00:00.000Z");
    expect(opensAt("2029-02-30")).toBeNaN();
    expect(opensAt("14 Aug 2029")).toBeNaN();
    expect(sastDay(Date.UTC(2026, 10, 18, 22, 30))).toBe("2026-11-19");
  });
});

describe("letterState", () => {
  it("unlock opens only when the estate is Unlocked", () => {
    expect(letterState(letter(), ctx())).toBe("locked");
    expect(letterState(letter(), ctx({ status: "DeathPending" }))).toBe("locked");
    expect(letterState(letter(), ctx({ status: "Unlocked" }))).toBe("open");
  });
  it("date opens at 00:00 SAST on the day", () => {
    const l = letter({ opens: { kind: "date", on: "2029-08-14" } });
    expect(letterState(l, ctx({ nowMs: Date.UTC(2029, 7, 13, 21, 59) }))).toBe("locked");
    expect(letterState(l, ctx({ nowMs: Date.UTC(2029, 7, 13, 22, 0) }))).toBe("open");
  });
  it("payment opens once the rule has paid more than when it was linked; an unreadable rule stays locked", () => {
    const l = letter({ opens: { kind: "payment", rule: RULE }, baseline: "500" });
    expect(letterState(l, ctx({ ruleSpent: () => 500n }))).toBe("locked");
    expect(letterState(l, ctx({ ruleSpent: () => 501n }))).toBe("open");
    expect(letterState(l, ctx({ ruleSpent: () => null }))).toBe("locked");
    expect(letterState({ ...l, baseline: undefined }, ctx({ ruleSpent: () => 9n }))).toBe("locked");
  });
  it("send opens when the transfer is confirmed", () => {
    const l = letter({ opens: { kind: "send", signature: "5".repeat(88) } });
    expect(letterState(l, ctx())).toBe("locked");
    expect(letterState(l, ctx({ sendConfirmed: () => true }))).toBe("open");
  });
  it("openedAt is sticky; a deleted letter is locked", () => {
    expect(letterState(letter({ openedAt: 1 }), ctx())).toBe("open");
    expect(letterState(letter({ openedAt: 1, deleted: true }), ctx({ status: "Unlocked" }))).toBe("locked");
  });
});

describe("canRead", () => {
  it("the author always reads", () => expect(canRead(letter(), OWNER, ctx())).toBe(true));
  it("a person letter: only its recipient, only once open", () => {
    expect(canRead(letter(), LERATO, ctx())).toBe(false);
    expect(canRead(letter(), LERATO, ctx({ status: "Unlocked" }))).toBe(true);
    expect(canRead(letter(), SIPHO, ctx({ status: "Unlocked" }))).toBe(false);
  });
  it("a family letter: active beneficiaries only; a removed beneficiary loses access; buyers never", () => {
    const fam = letter({ to: { kind: "family" } });
    const open = ctx({ status: "Unlocked" });
    expect(canRead(fam, SIPHO, open)).toBe(true);
    expect(canRead(fam, BUYER, open)).toBe(false);
    expect(canRead(fam, SIPHO, { ...open, activeBeneficiaries: [LERATO] })).toBe(false);
    expect(canRead(letter(), LERATO, { ...open, activeBeneficiaries: [SIPHO] })).toBe(false);
    expect(canRead(fam, null, open)).toBe(false);
  });
});

describe("canWrite", () => {
  const w = (over: Partial<WriteCtx> = {}): WriteCtx => ({ actor: OWNER, owner: OWNER, status: "Active", existing: null, existingOpen: false, version: 1, liveCount: 0, action: "write", ...over });
  it("only the owner", () => expect(canWrite(w({ actor: LERATO }))).toBe("forbidden"));
  it("pauses while a passing is confirmed and seals after unlock", () => {
    expect(canWrite(w({ status: "DeathPending" }))).toBe("paused");
    expect(canWrite(w({ status: "Unlocked" }))).toBe("sealed");
    expect(canWrite(w({ status: "Frozen" }))).toBe("sealed");
  });
  it("an opened letter can be deleted but not edited", () => {
    const existing = letter({ openedAt: 1 });
    expect(canWrite(w({ existing, existingOpen: true, version: 2 }))).toBe("opened");
    expect(canWrite(w({ existing, existingOpen: true, version: 2, action: "delete" }))).toBeNull();
  });
  it("the version must be stored + 1", () => {
    expect(canWrite(w({ version: 2 }))).toBe("version");
    expect(canWrite(w({ existing: letter({ version: 3 }), version: 3 }))).toBe("version");
    expect(canWrite(w({ existing: letter({ version: 3 }), version: 4 }))).toBeNull();
    expect(canWrite(w({ action: "delete" }))).toBe("version");
  });
  it("at most 50 live letters", () => {
    expect(canWrite(w({ liveCount: 49 }))).toBeNull();
    expect(canWrite(w({ liveCount: 50 }))).toBe("full");
    expect(canWrite(w({ liveCount: 50, existing: letter(), version: 2 }))).toBeNull();
  });
});

describe("checkLetter", () => {
  const c: CheckCtx = { nowMs: NOW, activeBeneficiaries: [LERATO, SIPHO, NALEDI], rules: [{ address: RULE, beneficiary: NALEDI }], assets: [CAR], canTranscribe: (p) => p.startsWith("local:") };
  const input = (over: Partial<LetterInput> = {}): LetterInput => ({ id: "ltr_AAAAAAAAAAAAAAAA", to: { kind: "person", wallet: NALEDI }, opens: { kind: "unlock" }, occasion: "", text: "Hello", ...over });
  it("accepts a good letter", () => expect(checkLetter(input(), c)).toBeNull());
  it("checks the id", () => expect(checkLetter(input({ id: "ltr_0OIl" }), c)?.code).toBe("id"));
  it("counts length after cleaning", () => {
    expect(checkLetter(input({ text: " \n\u0001 " }), c)?.code).toBe("empty");
    expect(checkLetter(input({ text: "a".repeat(2000) }), c)).toBeNull();
    expect(checkLetter(input({ text: `  ${"a".repeat(2000)}  \r\n` }), c)).toBeNull();
    expect(checkLetter(input({ text: "a".repeat(2001) }), c)?.code).toBe("tooLong");
    expect(checkLetter(input({ occasion: "x".repeat(61) }), c)?.code).toBe("occasion");
    expect(checkLetter(input({ occasion: `${"x".repeat(30)}      ${"x".repeat(29)}` }), c)).toBeNull();
  });
  it("a person recipient must be an active beneficiary", () => expect(checkLetter(input({ to: { kind: "person", wallet: BUYER } }), c)?.code).toBe("recipient"));
  it("a date must be real, after today (SAST) and before 2127", () => {
    expect(checkLetter(input({ opens: { kind: "date", on: "2026-11-18" } }), c)?.code).toBe("date");
    expect(checkLetter(input({ opens: { kind: "date", on: "2026-11-19" } }), c)).toBeNull();
    expect(checkLetter(input({ opens: { kind: "date", on: "2127-01-01" } }), c)?.code).toBe("date");
    expect(checkLetter(input({ opens: { kind: "date", on: "2029-02-30" } }), c)?.code).toBe("date");
  });
  it("a payment link must be the recipient's own rule; family letters cannot use payment or send", () => {
    expect(checkLetter(input({ opens: { kind: "payment", rule: RULE } }), c)).toBeNull();
    expect(checkLetter(input({ to: { kind: "person", wallet: LERATO }, opens: { kind: "payment", rule: RULE } }), c)?.code).toBe("link");
    expect(checkLetter(input({ to: { kind: "family" }, opens: { kind: "payment", rule: RULE } }), c)?.code).toBe("link");
    expect(checkLetter(input({ to: { kind: "family" }, opens: { kind: "send", signature: "5".repeat(88) } }), c)?.code).toBe("link");
    expect(checkLetter(input({ opens: { kind: "payment", rule: CAR } }), c)?.code).toBe("link");
  });
  it("about must be one of the estate's assets", () => expect(checkLetter(input({ about: { asset: RULE } }), c)?.code).toBe("about"));
  it("transcribed only for someone who passed or has no wallet, never in the future", () => {
    expect(checkLetter(input({ transcribed: { person: "local:mkhulu-joseph", year: 2001 } }), c)).toBeNull();
    expect(checkLetter(input({ transcribed: { person: LERATO, year: 2001 } }), c)?.code).toBe("transcribed");
    expect(checkLetter(input({ transcribed: { person: "local:mkhulu-joseph", year: 2030 } }), c)?.code).toBe("transcribed");
  });
});

describe("visibleCounts", () => {
  it("only opened, non-deleted letters, by the year they opened, with no ids or text", () => {
    const counts = visibleCounts([
      letter({ openedAt: Date.UTC(2029, 7, 14) / 1000 }),
      letter({ id: "ltr_BBBBBBBBBBBBBBBB" }),
      letter({ id: "ltr_CCCCCCCCCCCCCCCC", openedAt: 5, deleted: true }),
      letter({ id: "ltr_DDDDDDDDDDDDDDDD", to: { kind: "family" }, opens: { kind: "date", on: "2026-11-18" } }),
    ], ctx());
    expect(counts).toEqual([{ from: OWNER, to: LERATO, year: 2029 }, { from: OWNER, to: "family", year: 2026 }]);
    expect(JSON.stringify(counts)).not.toMatch(/ltr_|Hello/);
  });
});

describe("canonical form and signature", () => {
  const input: LetterInput = { id: "ltr_AAAAAAAAAAAAAAAA", to: { kind: "person", wallet: NALEDI }, opens: { kind: "payment", rule: RULE }, occasion: " For your  18th ", text: "Naledi,\r\ntoday you are 18.  ", about: { asset: CAR } };
  it("has a fixed key order and cleans text and occasion", () => {
    const c = canonicalLetter(E, OWNER, { ...input, about: { asset: CAR }, opens: { rule: RULE, kind: "payment" } as never }, 1);
    expect(Object.keys(JSON.parse(c))).toEqual(["id", "estate", "from", "to", "opens", "occasion", "text", "about", "version"]);
    expect(c).toContain('"opens":{"kind":"payment","rule":"');
    expect(JSON.parse(c).occasion).toBe("For your 18th");
    expect(JSON.parse(c).text).toBe("Naledi,\ntoday you are 18.");
    expect(cleanLetterText("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(cleanOccasion("a\tb\nc")).toBe("a b c");
  });
  it("the same input gives the same hash; one character changes it", async () => {
    const h1 = await letterHash(E, OWNER, input, 1);
    expect(await letterHash(E, OWNER, { ...input }, 1)).toBe(h1);
    expect(await letterHash(E, OWNER, { ...input, text: `${input.text}!` }, 1)).not.toBe(h1);
    expect(await letterHash(E, OWNER, input, 2)).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it("a wallet signature verifies over letterMessage", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const msg = letterMessage("delete", E, address, NOW, await letterHash(E, OWNER, input, 1));
    const sig = edSign(null, Buffer.from(msg), privateKey);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(bs58.decode(address))]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(msg), key, sig)).toBe(true);
    expect(msg.split("\n")[0]).toBe("Heirloom letter");
    expect(deleteBody("ltr_AAAAAAAAAAAAAAAA", 2)).toBe('{"id":"ltr_AAAAAAAAAAAAAAAA","version":2}');
  });
  it("makes valid ids", () => {
    for (let i = 0; i < 20; i++) expect(newLetterId()).toMatch(LETTER_ID);
  });
});

describe("a reused rule slot (claim id generation)", () => {
  const ctx = (spent: bigint, generation: number) => ({ status: "Active" as const, nowMs: 0, sendConfirmed: () => false, ruleSpent: () => spent, ruleGeneration: () => generation });
  const l = (baseline: string) => ({ opens: { kind: "payment" as const, rule: "R" }, openedAt: null, baseline });
  it("a gift linked to the old rule never opens with the new rule's payments", () => {
    expect(letterState(l(linkBaseline({ spentTotal: 300n, claimCount: 2 })), ctx(500n, 1))).toBe("locked");
    expect(letterState(l(linkBaseline({ spentTotal: 0n, claimCount: 65_536 })), ctx(500n, 1))).toBe("open");
    expect(letterState(l("300"), ctx(500n, 0))).toBe("open");
  });
});
