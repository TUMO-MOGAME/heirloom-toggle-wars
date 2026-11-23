/**
 * /api/letters and /api/letters/review without a network (plan.md §16.12): deps injected like photoRoutes, Supabase
 * off (server memory), real ed25519 signatures.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { lettersRoutes, type LettersRouteDeps } from "./server/route";
import { reviewRoutes } from "./server/review-route";
import { resetLettersMemory } from "./server/store";
import { canonicalLetter, deleteBody, LIST_BODY, letterMessage, type LetterAction } from "./canonical";
import { canonicalJson } from "../agent/hash";
import { DEMO_LETTER_IDS } from "./demo";
import type { EstateSnapshot } from "../service/types";
import type { EstateStatus, Rule } from "../types";
import type { LetterInput, LettersView, LetterView } from "./types";
import { DEVNET_DEMO_CHILDREN, DEVNET_DEMO_ESTATE } from "../chain/demo-estate";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}
type W = ReturnType<typeof wallet>;
const owner = wallet(), lerato = wallet(), sipho = wallet(), buyer = wallet();
const E = "EsTaTeTeStAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RULE = "RuLeLeRaToAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIPHO_RULE = "RuLeSiPhoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CAR = "CaRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const rule = (address: string, beneficiary: string, spent: bigint): Rule => ({
  address, id: 0, beneficiary, category: "General", allowedPayeeKind: "Other", maxPerClaim: 60_000_000n, lifetimeCap: 720_000_000n, spentTotal: spent,
  validUntil: 2_000_000_000, startsNow: true, recurringAmount: 0n, intervalSecs: 0, nextDue: null, fixedPayee: null,
});
let status: EstateStatus = "Active";
let spent = 0n;
const snapshot = (estate = E): EstateSnapshot => ({
  estate: {
    address: estate, owner: owner.address, ownerName: "Thabo Mokoena", agent: E, usdtMint: E, verifiers: [E, E, E], verifierNames: ["a", "b", "c"],
    deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60, status, willHash: null, vaultBalance: 0n,
    death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null }, lastHeartbeat: 0,
  },
  beneficiaries: [
    { address: E, wallet: lerato.address, label: "Lerato (daughter)", active: true },
    { address: E, wallet: sipho.address, label: "Sipho (son)", active: true },
  ],
  payees: [], rules: [rule(RULE, lerato.address, spent), rule(SIPHO_RULE, sipho.address, 0n)], claims: [], offers: [], hardships: [], activity: [],
  assets: [{ address: CAR, nftMint: E, title: "2017 Toyota Corolla 1.8 Exclusive CVT", floorPrice: 1n, hardshipFloor: 1n, askingPrice: 1n, proceedsTo: estate, status: "Held", listingEnds: null, docHash: "", hardshipBeneficiary: null }],
});

let chain = true;
let clock = Date.UTC(2026, 10, 18, 10);
const deps: LettersRouteDeps = { chain: () => chain, now: () => clock, snapshot: async (e) => (e === E || e === DEVNET_DEMO_ESTATE ? snapshot(e) : null) };
const routes = lettersRoutes(deps);
let n = 0;
const nextTs = () => clock + (++n % 10_000);

function signed(w: W, action: LetterAction, estate: string, bodyText: string, extra: Record<string, unknown>, at = nextTs()) {
  return { action, estate, wallet: w.address, ts: at, sig: w.sign(letterMessage(action, estate, w.address, at, sha(bodyText))), ...extra };
}
const post = (body: unknown) => routes.POST(new Request("http://local/api/letters", { method: "POST", body: JSON.stringify(body) }));
const write = (w: W, input: LetterInput, version: number, estate = E) => post(signed(w, "write", estate, canonicalLetter(estate, w.address, input, version), { letter: input, version }));
const del = (w: W, id: string, version: number, estate = E) => post(signed(w, "delete", estate, deleteBody(id, version), { id, version }));
const list = async (w: W, estate = E) => post(signed(w, "list", estate, LIST_BODY, {}));
const input = (over: Partial<LetterInput> = {}): LetterInput => ({ id: "ltr_AAAAAAAAAAAAAAAA", to: { kind: "person", wallet: lerato.address }, opens: { kind: "unlock" }, occasion: "For later", text: "Dear Lerato", ...over });

beforeEach(() => { resetLettersMemory(); chain = true; status = "Active"; spent = 0n; clock = Date.UTC(2026, 10, 18, 10); });

describe("/api/letters", () => {
  it("503 on the demo deployment", async () => {
    chain = false;
    const r = await write(owner, input(), 1);
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("unavailable");
  });

  it("401 for a stale request, a wrong signature and a replay", async () => {
    const stale = signed(owner, "list", E, LIST_BODY, {}, clock - 6 * 60_000);
    expect((await post(stale)).status).toBe(401);
    const forged = { ...signed(owner, "list", E, LIST_BODY, {}), wallet: lerato.address };
    expect((await (await post(forged)).json()).code).toBe("unauthorized");
    const once = signed(owner, "list", E, LIST_BODY, {});
    expect((await post(once)).status).toBe(200);
    expect((await (await post(once)).json()).code).toBe("replay");
  });

  it("400 for a bad shape, 413 for a body or a letter that is too long", async () => {
    expect((await post({ action: "write" })).status).toBe(400);
    const long = await write(owner, input({ text: "a".repeat(2001) }), 1);
    expect(long.status).toBe(413);
    const huge = await post({ ...signed(owner, "list", E, LIST_BODY, {}), pad: "x".repeat(17 * 1024) });
    expect(huge.status).toBe(413);
  });

  it("403: only the owner writes; only the family lists", async () => {
    expect((await (await write(lerato, input(), 1)).json()).code).toBe("forbidden");
    expect((await (await list(buyer)).json()).code).toBe("not_family");
  });

  it("409 paused, sealed, opened and version", async () => {
    expect((await write(owner, input(), 1)).status).toBe(200);
    expect((await (await write(owner, input({ text: "again" }), 1)).json()).code).toBe("version");
    status = "DeathPending";
    expect((await (await write(owner, input(), 2)).json()).code).toBe("paused");
    status = "Unlocked";
    expect((await (await del(owner, input().id, 2)).json()).code).toBe("sealed");
    status = "Active";
    const open = input({ id: "ltr_BBBBBBBBBBBBBBBB", opens: { kind: "date", on: "2026-11-19" } });
    expect((await write(owner, open, 1)).status).toBe(200);
    clock = Date.UTC(2026, 10, 19, 6);
    expect((await (await write(owner, { ...open, text: "changed" }, 2)).json()).code).toBe("opened");
    expect((await del(owner, open.id, 2)).status).toBe(200);
  });

  it("422 bad_link for another person's rule, bad_letter with the field", async () => {
    const r = await write(owner, input({ opens: { kind: "payment", rule: SIPHO_RULE } }), 1);
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("bad_link");
    const d = await (await write(owner, input({ opens: { kind: "date", on: "2020-01-01" } }), 1)).json();
    expect([d.code, d.field]).toEqual(["bad_letter", "opens"]);
  });

  it("sets the payment baseline from the rule and opens after the next payment", async () => {
    spent = 60_000_000n;
    const gift = input({ opens: { kind: "payment", rule: RULE } });
    const saved = (await (await write(owner, gift, 1)).json()).letter as LetterView;
    expect([saved.baseline, saved.state]).toEqual(["60000000", "locked"]);
    expect(((await (await list(lerato)).json()) as LettersView).letters).toEqual([]);
    spent = 120_000_000n;
    const mine = ((await (await list(lerato)).json()) as LettersView).letters;
    expect(mine.map((l) => [l.id, l.state, l.text])).toEqual([[gift.id, "open", "Dear Lerato"]]);
    expect(mine[0].openedAt).toBeGreaterThan(0);
  });

  it("recipients never see locked letters; siblings never see each other's letters", async () => {
    await write(owner, input({ opens: { kind: "date", on: "2026-11-19" } }), 1);
    await write(owner, input({ id: "ltr_CCCCCCCCCCCCCCCC", to: { kind: "family" } }), 1);
    expect(((await (await list(lerato)).json()) as LettersView).letters).toEqual([]);
    clock = Date.UTC(2026, 10, 19, 6);
    expect(((await (await list(lerato)).json()) as LettersView).letters.map((l) => l.id)).toEqual(["ltr_AAAAAAAAAAAAAAAA"]);
    const siblings = (await (await list(sipho)).json()) as LettersView;
    expect(siblings.letters).toEqual([]);
    expect(siblings.counts).toEqual([{ from: owner.address, to: lerato.address, year: 2026 }]);
    status = "Unlocked";
    expect(((await (await list(sipho)).json()) as LettersView).letters.map((l) => l.id)).toEqual(["ltr_CCCCCCCCCCCCCCCC"]);
  });

  it("a delete keeps a tombstone without text; the owner sees it, nobody reads it", async () => {
    await write(owner, input({ about: { asset: CAR } }), 1);
    expect((await del(owner, input().id, 2)).status).toBe(200);
    const mine = ((await (await list(owner)).json()) as LettersView).letters;
    expect(mine).toHaveLength(1);
    expect([mine[0].deleted, mine[0].text, mine[0].occasion, mine[0].about, mine[0].version]).toEqual([true, "", "", undefined, 2]);
    status = "Unlocked";
    expect(((await (await list(lerato)).json()) as LettersView).letters).toEqual([]);
  });

  it("the seeded devnet estate starts with the demo letters; a stored tombstone hides one", async () => {
    // The children in the seeded letters are the devnet demo wallets, so the snapshot's beneficiaries do not hold
    // them: the owner still sees all four (L3 opens on Naledi's birthday without the gift rule).
    const mine = ((await (await list(owner, DEVNET_DEMO_ESTATE)).json()) as LettersView).letters;
    expect(mine.map((l) => l.id).sort()).toEqual(Object.values(DEMO_LETTER_IDS).sort());
    const naledi = mine.find((l) => l.id === DEMO_LETTER_IDS.naledi)!;
    expect(naledi.opens).toEqual({ kind: "date", on: "2029-08-14" });
    expect(naledi.to).toEqual({ kind: "person", wallet: DEVNET_DEMO_CHILDREN.naledi });
    expect(mine.find((l) => l.id === DEMO_LETTER_IDS.mkhulu)!.state).toBe("open");
    expect(mine.every((l) => l.sig === null && l.demoKey)).toBe(true);
    expect((await del(owner, DEMO_LETTER_IDS.family, 2, DEVNET_DEMO_ESTATE)).status).toBe(200);
    const after = ((await (await list(owner, DEVNET_DEMO_ESTATE)).json()) as LettersView).letters;
    expect(after.find((l) => l.id === DEMO_LETTER_IDS.family)?.deleted).toBe(true);
  });
});

describe("/api/letters/review", () => {
  const routesNoAi = reviewRoutes({ ...deps, ai: () => false, usdtZar: async () => 18 });
  const reviewPost = (r: ReturnType<typeof reviewRoutes>, body: unknown) => r.POST(new Request("http://local/api/letters/review", { method: "POST", body: JSON.stringify(body) }));
  const review = (w: W, draft: LetterInput, r = routesNoAi) => reviewPost(r, signed(w, "review", E, canonicalJson(draft), { draft, locale: "en" }));

  it("warns with the rules when there is no AI key", async () => {
    const r = await review(owner, input({ text: "Lerato, the Corolla is yours, the PIN is 4821" }));
    const body = await r.json();
    expect(body.source).toBe("rules");
    expect(body.warnings.map((w: { code: string }) => w.code)).toEqual(["secret.pin", "will.asset"]);
  });

  it("an AI error still answers with the rules' warnings", async () => {
    // ai() says yes, but no GEMINI_API_KEY is set in tests, so the agent layer throws: rules only.
    const r = await review(owner, input({ text: "my PIN is 1234" }), reviewRoutes({ ...deps, ai: () => true, usdtZar: async () => 18 }));
    const body = await r.json();
    expect([body.source, body.warnings.map((w: { code: string }) => w.code)]).toEqual(["rules", ["secret.pin"]]);
  });

  it("owner only, Active only", async () => {
    expect((await review(lerato, input())).status).toBe(403);
    status = "DeathPending";
    expect((await (await review(owner, input())).json()).code).toBe("paused");
  });

  it("suggests a template without a key", async () => {
    const body0 = { to: { kind: "person", wallet: lerato.address }, occasion: "For your graduation", points: "" };
    const r = await reviewPost(routesNoAi, signed(owner, "suggest", E, canonicalJson(body0), { input: body0, locale: "en" }));
    const body = await r.json();
    expect(body.source).toBe("template");
    expect(body.text).toContain("Lerato,");
    expect(body.text).toContain("For your graduation.");
  });
});
