/**
 * Letters on chain, without a network (plan.md §16.12): signed calls to the real route handler, the owner's device
 * copy (merge by version, tombstones), a server without a store (503) keeping the device copy, and recipients keeping
 * no letter text on their device.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { createChainLetters } from "./chain-letters";
import { lettersRoutes } from "../letters/server/route";
import { resetLettersMemory } from "../letters/server/store";
import { mergeLetters, newer } from "../letters/device";
import { sastDay } from "../letters/rules";
import type { EstateSnapshot } from "./types";
import type { Letter, LetterInput } from "../letters/types";

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { address, signMessage: async (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}
const owner = wallet(), lerato = wallet();
const E = "EsTaTeChAiNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const snap: EstateSnapshot = {
  estate: {
    address: E, owner: owner.address, ownerName: "Thabo", agent: E, usdtMint: E, verifiers: [E, E, E], verifierNames: ["a", "b", "c"],
    deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 60, status: "Active", willHash: null, vaultBalance: 0n,
    death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null }, lastHeartbeat: 0,
  },
  beneficiaries: [{ address: E, wallet: lerato.address, label: "Lerato (daughter)", active: true }],
  payees: [], rules: [], claims: [], assets: [], offers: [], hardships: [], activity: [],
};

class MemoryStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } }

let serverUp = true;
const routes = lettersRoutes({ chain: () => true, now: () => Date.now(), snapshot: async () => snap });
const fetchStub: typeof fetch = async (input, init) => {
  if (!serverUp) return new Response(JSON.stringify({ code: "unavailable" }), { status: 503 });
  return routes.POST(new Request(`http://local${String(input)}`, init));
};
const client = (w: ReturnType<typeof wallet>, storage: MemoryStorage) => createChainLetters({
  getEstate: async () => snap, signer: () => w, fetch: fetchStub, storage, now: () => Date.now(),
});
const input = (over: Partial<LetterInput> = {}): LetterInput => ({ id: "ltr_ChainAAAAAAAAAAA", to: { kind: "person", wallet: lerato.address }, opens: { kind: "date", on: "2099-01-01" }, occasion: "", text: "Hello Lerato", ...over });

beforeEach(() => { resetLettersMemory(); serverUp = true; });

describe("chain letters", () => {
  it("saves through the signed route and keeps the owner's copy on the device", async () => {
    const dev = new MemoryStorage();
    const c = client(owner, dev);
    const saved = await c.saveLetter(E, input(), 1);
    expect([saved.version, saved.sig?.length]).toEqual([1, 128]);
    expect(dev.getItem("heirloom.letters.v1")).toContain("Hello Lerato");
    expect((await c.listLetters(E)).letters.map((l) => l.text)).toEqual(["Hello Lerato"]);
  });

  it("a server without a store (503) keeps the device copy: the owner still saves, sees and deletes", async () => {
    const dev = new MemoryStorage();
    const c = client(owner, dev);
    serverUp = false;
    await c.saveLetter(E, input(), 1);
    expect((await c.listLetters(E)).letters.map((l) => [l.id, l.text])).toEqual([[input().id, "Hello Lerato"]]);
    await c.saveLetter(E, input({ text: "Edited offline" }), 2);
    await c.deleteLetter(E, input().id, 3);
    const after = (await c.listLetters(E)).letters;
    expect([after[0].deleted, after[0].text, after[0].version]).toEqual([true, "", 3]);
    // The review still answers with the rules.
    expect((await c.reviewLetter(E, input({ text: "my PIN is 1234" }), "en")).warnings.map((w) => w.code)).toEqual(["secret.pin"]);
  });

  it("merges the server and the device by version; a tombstone wins a tie", async () => {
    const base = { ...input(), estate: E, from: owner.address, hash: "0".repeat(64), sig: null, signedAt: 0, createdAt: 0, updatedAt: 0, openedAt: null } as Letter;
    const v2 = { ...base, version: 2, text: "two" }, v3 = { ...base, version: 3, text: "three" }, gone = { ...base, version: 2, text: "", deleted: true as const };
    expect(newer(v2, v3).text).toBe("three");
    expect(newer(v2, gone).deleted).toBe(true);
    expect(mergeLetters([v3], [v2], (l) => l)[0].text).toBe("three");
    expect(mergeLetters([v2], [v3], (l) => l)[0].text).toBe("three");
    expect(mergeLetters([v2], [gone], (l) => l)[0].deleted).toBe(true);
  });

  it("a quiet (background) read never signs while the wallet is locked: no PIN prompt; it answers from this device", async () => {
    const dev = new MemoryStorage();
    await client(owner, dev).saveLetter(E, input(), 1);
    let signed = 0, fetched = 0;
    const locked = { address: owner.address, canSignQuietly: () => false, signMessage: async (m: string) => { signed++; return owner.signMessage(m); } };
    const counting: typeof fetch = async (i, init) => { fetched++; return fetchStub(i, init); };
    const c = createChainLetters({ getEstate: async () => snap, signer: () => locked, fetch: counting, storage: dev, now: () => Date.now() });
    expect((await c.listLetters(E, { quiet: true })).letters.map((l) => l.text)).toEqual(["Hello Lerato"]);
    await c.letterCounts(E);
    expect([signed, fetched]).toEqual([0, 0]);
    // The letters page itself still signs (and so may ask for the PIN).
    await c.listLetters(E);
    expect([signed, fetched]).toEqual([1, 1]);
    // Once unlocked, a quiet read goes to the server too.
    const open = { ...locked, canSignQuietly: () => true };
    const c2 = createChainLetters({ getEstate: async () => snap, signer: () => open, fetch: counting, storage: dev, now: () => Date.now() });
    await c2.listLetters(E, { quiet: true });
    expect([signed, fetched]).toEqual([2, 2]);
  });

  it("recipients keep no letter text on their device", async () => {
    const tomorrow = sastDay(Date.now() + 86_400_000);
    await client(owner, new MemoryStorage()).saveLetter(E, input({ opens: { kind: "date", on: tomorrow } }), 1);
    const later = Date.now() + 3 * 86_400_000;
    const routesLater = lettersRoutes({ chain: () => true, now: () => later, snapshot: async () => snap });
    const dev = new MemoryStorage();
    const c = createChainLetters({
      getEstate: async () => snap, signer: () => lerato, storage: dev, now: () => later,
      fetch: async (u, init) => routesLater.POST(new Request(`http://local${String(u)}`, init)),
    });
    expect((await c.listLetters(E)).letters.map((l) => l.text)).toEqual(["Hello Lerato"]);
    expect([...dev.m.values()].join("")).not.toContain("Hello Lerato");
  });

  it("refusals come back as letter errors with the route's code", async () => {
    await expect(client(lerato, new MemoryStorage()).saveLetter(E, input(), 1)).rejects.toMatchObject({ code: "forbidden" });
    await expect(client(owner, new MemoryStorage()).saveLetter(E, input({ text: "a".repeat(2001) }), 1)).rejects.toMatchObject({ code: "too_large" });
  });
});
