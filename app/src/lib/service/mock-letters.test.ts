/** Letters for later in the demo (plan.md §16.12): the story letters, reading by persona, sealing, gift links, counts. */
import { describe, expect, it } from "vitest";
import { createMockService, DEMO_PERSONAS, type DemoStage, type MockService } from "./mock";
import { STORY_AMAHLE, STORY_ESTATE_LERATO } from "./mock-tree";
import { STORY_AMAHLE_WALLET, STORY_LERATO_ESTATE } from "./mock-letters";
import { DEMO_LETTER_IDS } from "../letters/demo";
import { scheduleStepDue } from "../schedule-step";
import { toBase } from "../format";
import type { LetterInput } from "../letters/types";

type Key = (typeof DEMO_PERSONAS)[number]["key"];
const P = (k: Key) => DEMO_PERSONAS.find((p) => p.key === k)!;
function demo(stage: DemoStage): MockService & { as(k: Key): void } {
  const svc = createMockService({ instant: true });
  svc.resetDemo(stage);
  return Object.assign(svc, { as: (k: Key) => svc.setActor({ address: P(k).address, role: P(k).role, label: P(k).label }) });
}
const ids = (ls: { id: string }[]) => ls.map((l) => l.id).sort();
const estateOf = async (svc: MockService) => { svc.setActor({ address: P("thabo").address, role: "owner", label: "Thabo" }); return (await svc.getEstate("")).estate.address; };
const letter = (over: Partial<LetterInput> = {}): LetterInput => ({ id: "ltr_TestAAAAAAAAAAAA", to: { kind: "person", wallet: P("lerato").address }, opens: { kind: "unlock" }, occasion: "", text: "For you", ...over });

describe("mock letters", () => {
  it("the story letters are there for the owner from the funded stage; none before a plan", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const mine = (await svc.listLetters(E)).letters;
    expect(ids(mine)).toEqual(Object.values(DEMO_LETTER_IDS).sort());
    const naledi = mine.find((l) => l.id === DEMO_LETTER_IDS.naledi)!;
    expect(naledi.opens.kind).toBe("payment");
    expect([naledi.hint.giftUsdt, naledi.state]).toEqual([500, "locked"]);
    expect(mine.find((l) => l.id === DEMO_LETTER_IDS.mkhulu)!.state).toBe("open");
    const fresh = demo("fresh");
    fresh.as("thabo");
    await expect(fresh.listLetters("")).rejects.toThrow();
  });

  it("reading follows the persona: recipients see open letters meant for them, a buyer nothing", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    svc.as("lerato");
    expect(ids((await svc.listLetters(E)).letters)).toEqual([DEMO_LETTER_IDS.mkhulu]);
    svc.as("zanele");
    await expect(svc.listLetters(E)).rejects.toMatchObject({ code: "not_family" });

    const after = demo("unlocked");
    const E2 = await estateOf(after);
    after.as("lerato");
    expect(ids((await after.listLetters(E2)).letters)).toEqual([DEMO_LETTER_IDS.family, DEMO_LETTER_IDS.lerato, DEMO_LETTER_IDS.mkhulu].sort());
    after.as("naledi");
    expect(ids((await after.listLetters(E2)).letters)).toEqual([DEMO_LETTER_IDS.family, DEMO_LETTER_IDS.mkhulu].sort());
  });

  it("the owner writes, edits and deletes; letters seal at unlock", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const v1 = await svc.saveLetter(E, letter(), 1);
    expect([v1.version, v1.state, v1.text]).toEqual([1, "locked", "For you"]);
    await expect(svc.saveLetter(E, letter({ text: "x" }), 1)).rejects.toMatchObject({ code: "version" });
    expect((await svc.saveLetter(E, letter({ text: "Changed" }), 2)).text).toBe("Changed");
    await svc.deleteLetter(E, letter().id, 3);
    const gone = (await svc.listLetters(E)).letters.find((l) => l.id === letter().id)!;
    expect([gone.deleted, gone.text]).toEqual([true, ""]);
    svc.as("lerato");
    await expect(svc.saveLetter(E, letter({ id: "ltr_TestBBBBBBBBBBBB" }), 1)).rejects.toMatchObject({ code: "forbidden" });

    const sealed = demo("unlocked");
    const E2 = await estateOf(sealed);
    await expect(sealed.saveLetter(E2, letter(), 1)).rejects.toMatchObject({ code: "sealed" });
    expect((await sealed.listLetters(E2)).sealed).toBe(true);
  });

  it("a payment link opens after a scheduled payment", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const books = (await svc.getEstate(E)).rules.find((r) => r.category === "Books")!;
    await svc.saveLetter(E, letter({ opens: { kind: "payment", rule: books.address } }), 1);
    svc.as("lerato");
    expect(ids((await svc.listLetters(E)).letters)).not.toContain(letter().id);
    svc.makeDue();
    svc.as("thabo");
    await svc.executeScheduled(E, books.address);
    svc.as("lerato");
    const open = (await svc.listLetters(E)).letters.find((l) => l.id === letter().id)!;
    expect(open.state).toBe("open");
    expect(open.hint.paidSig).toBeTruthy();
  });

  it("a payment link opens after a claim payout (Lerato's everyday request)", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const snap = await svc.getEstate(E);
    const everyday = snap.rules.find((r) => r.category === "General" && r.beneficiary === P("lerato").address)!;
    const ask = snap.claims.find((c) => c.rule === everyday.address && c.status === "Open")!;
    await svc.saveLetter(E, letter({ opens: { kind: "payment", rule: everyday.address } }), 1);
    // A claim rule has no set payment: its per-claim limit is never shown as the gift.
    expect((await svc.listLetters(E)).letters.find((l) => l.id === letter().id)!.hint.giftUsdt).toBeUndefined();
    await svc.ownerApproveClaim(E, ask.address);
    await svc.executeClaim(E, ask.address);
    svc.as("lerato");
    const opened = (await svc.listLetters(E)).letters.find((l) => l.id === letter().id)!;
    expect(opened.state).toBe("open");
    expect(opened.hint.giftUsdt).toBe(Number(ask.amount) / 1e6); // the amount actually paid
    svc.as("sipho");
    expect(ids((await svc.listLetters(E)).letters)).not.toContain(letter().id);
  });

  it("Naledi's gift rule is first due on her birthday and the demo walk ignores it; paying it opens her letter", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const snap = await svc.getEstate(E);
    const gift = snap.rules.find((r) => r.beneficiary === P("naledi").address && r.recurringAmount === toBase(500))!;
    expect(new Date(gift.nextDue! * 1000).toISOString()).toBe("2029-08-13T22:00:00.000Z");
    expect([gift.lifetimeCap, gift.startsNow, gift.fixedPayee]).toEqual([toBase(500), true, P("naledi").address]);
    expect(scheduleStepDue([gift], Math.floor(Date.now() / 1000))).toBe(false);
    expect(scheduleStepDue([{ ...gift, nextDue: Math.floor(Date.now() / 1000) }], Math.floor(Date.now() / 1000))).toBe(true);
    // The rest of the walk is unchanged: the stock schedule (Lerato's books) already paid in the seed.
    expect(scheduleStepDue(snap.rules, Math.floor(Date.now() / 1000))).toBe(false);
    await svc.listLetters(E);
    svc.makeDue();
    await svc.executeScheduled(E, gift.address);
    svc.as("naledi");
    expect(ids((await svc.listLetters(E)).letters)).toContain(DEMO_LETTER_IDS.naledi);
  });

  it("review warns (the demo walk's draft) and the help is a template", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const r = await svc.reviewLetter(E, letter({ text: "Lerato, the Corolla is yours, the PIN is 4821" }), "en");
    expect([r.source, r.warnings.map((w) => w.code)]).toEqual(["rules", ["secret.pin", "will.asset"]]);
    const help = await svc.suggestLetter(E, { to: { kind: "person", wallet: P("naledi").address }, occasion: "For your 18th birthday", points: "" }, "en");
    expect(help.source).toBe("template");
    expect(help.text).toMatch(/^Naledi,/);
  });

  it("counts for the tree: real openings plus the story's imagined ones", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const counts = await svc.letterCounts(E);
    const thabo = P("thabo").address;
    expect(counts).toContainEqual({ from: thabo, to: "family", year: new Date().getUTCFullYear() });
    expect(counts).toContainEqual({ from: thabo, to: P("naledi").address, year: 2029, imagined: true });
    expect(counts).toContainEqual({ from: thabo, to: P("lerato").address, year: 2041, imagined: true });
    expect(counts).toContainEqual({ from: P("lerato").address, to: STORY_AMAHLE_WALLET, year: 2086, imagined: true });
    expect(JSON.stringify(counts)).not.toMatch(/ltr_|Dad|Corolla/);
  });

  it("letters never change the Trust Tree's fingerprint", async () => {
    const svc = demo("funded");
    const E = await estateOf(svc);
    const before = (await svc.getTree(E)).fingerprint;
    await svc.saveLetter(E, letter({ to: { kind: "family" } }), 1);
    await svc.letterCounts(E);
    expect((await svc.getTree(E)).fingerprint).toBe(before);
  });

  it("uses the tree story's ids for Lerato's plan and Amahle", () => {
    expect([STORY_LERATO_ESTATE, STORY_AMAHLE_WALLET]).toEqual([STORY_ESTATE_LERATO, STORY_AMAHLE]);
  });
});
