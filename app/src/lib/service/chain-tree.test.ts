/**
 * Trust Tree on chain, without a network:
 *  - decoding: recorded program logs (encoded with the bundled IDL) → events → tree facts;
 *  - history: paging `getSignaturesForAddress` with `before` past the feed's 40, stopping at the time budget (partial);
 *  - the tree from a devnet-like estate: default family, names, generations, child plans, no amounts;
 *  - relationships and hidden flags: signed writes through /api/tree (owner only; own flag only), Supabase off
 *    (server memory) plus this device's copy, and what happens when the server is down or refuses.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getCoder, getIdl } from "../chain/idl";
import { fetchHistory, historySignatures, type HistoryConn } from "../chain/reads";
import { treeEventsFromChain, type RawChainEvent } from "../tree/events";
import { createChainTree } from "./chain-tree";
import { treeRoutes } from "../tree/server/route";
import { resetTreeMemory } from "../tree/server/store";
import { photoRoutes } from "../tree/server/photo-route";
import { webpOf } from "../tree/photo-fixture";
import { DEVNET_DEMO_CHILDREN, DEVNET_DEMO_ESTATE, DEVNET_DEMO_GUARDIANS, DEVNET_DEMO_META, DEVNET_DEMO_VERIFIERS } from "../chain/demo-estate";
import { relationshipId, treeBody, treeMessage } from "../tree/links";
import { findAmounts } from "../tree/no-amounts";
import type { EstateSnapshot } from "./types";
import type { Raw } from "../chain/decoders";

const idl = getIdl();
const pk = (s: string) => new PublicKey(s);
const T0 = 1_794_752_081; // 15 Nov 2026, the devnet demo estate's first event

/** A program log line for `name` with `data`, exactly as the program emits it (Anchor `emit!`). */
function logFor(name: string, data: Record<string, unknown>): string {
  const ev = idl.events!.find((e) => e.name === name)!;
  return `Program data: ${Buffer.concat([Buffer.from(ev.discriminator), getCoder().types.encode(name, data)]).toString("base64")}`;
}
const tx = (lines: string[], blockTime: number) => ({ blockTime, meta: { logMessages: [`Program ${idl.address} invoke [1]`, ...lines, `Program ${idl.address} success`] } });

const E = DEVNET_DEMO_ESTATE;
const OWNER = DEVNET_DEMO_META.ownerWallet;
const { ndlovu, pillay, bongani } = DEVNET_DEMO_VERIFIERS;
const CLAIM = Keypair.generate().publicKey.toBase58();
const RULE = Keypair.generate().publicKey.toBase58();
const ASSET = Keypair.generate().publicKey.toBase58();

/** The recorded history: created, a school-fee claim approved by Adv. Ndlovu and paid, a car registered, guardians. */
function recorded(): { signature: string; logs: string[]; ts: number }[] {
  const i = (n: number) => T0 + n * 600;
  return [
    { signature: "sig-create", ts: i(0), logs: [logFor("EstateCreated", { estate: pk(E), owner: pk(OWNER), agent: Keypair.generate().publicKey, usdt_mint: Keypair.generate().publicKey, ts: new BN(i(0)) })] },
    { signature: "sig-claim", ts: i(1), logs: [logFor("ClaimSubmitted", { estate: pk(E), rule: pk(RULE), claim: pk(CLAIM), beneficiary: pk(DEVNET_DEMO_CHILDREN.naledi), payee: Keypair.generate().publicKey, amount: new BN(350_000_000), ts: new BN(i(1)) })] },
    { signature: "sig-approve", ts: i(2), logs: [
      logFor("ClaimApproved", { claim: pk(CLAIM), verifier: pk(ndlovu), count: 1, ts: new BN(i(2)) }),
      logFor("SeatApproval", { estate: pk(E), seat_index: 0, approver: pk(ndlovu), kind: { Claim: {} }, target: pk(CLAIM), ts: new BN(i(2)) }),
    ] },
    { signature: "sig-paid", ts: i(3), logs: [logFor("ClaimPaid", { estate: pk(E), rule: pk(RULE), claim: pk(CLAIM), payee: Keypair.generate().publicKey, amount: new BN(350_000_000), ts: new BN(i(3)) })] },
    { signature: "sig-asset", ts: i(4), logs: [logFor("AssetRegistered", { estate: pk(E), asset: pk(ASSET), nft_mint: Keypair.generate().publicKey, floor_price: new BN(1), hardship_floor: new BN(1), asking_price: new BN(1), ts: new BN(i(4)) })] },
    { signature: "sig-seat", ts: i(5), logs: [logFor("SeatConfigured", { estate: pk(E), seat_index: 2, holder: pk(bongani), backups: [pk(DEVNET_DEMO_GUARDIANS.kagiso), pk(DEVNET_DEMO_GUARDIANS.priya)], monitors: [pk(DEVNET_DEMO_GUARDIANS.zodwa), PublicKey.default], generation: 0, ts: new BN(i(5)) })] },
    { signature: "sig-offer", ts: i(6), logs: [logFor("OfferPlaced", { asset: pk(ASSET), offer: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, amount: new BN(9), ts: new BN(i(6)) })] },
  ];
}

/** A fake RPC: newest first, `before` paging, `getTransaction` from the recording. Each call advances the fake clock. */
function fakeConn(entries: { signature: string; logs: string[]; ts: number }[], clock: { t: number }, msPerCall = 0): HistoryConn & { pages: number } {
  const newest = [...entries].sort((a, b) => b.ts - a.ts);
  const conn = {
    pages: 0,
    async getSignaturesForAddress(_a: PublicKey, opts?: { limit?: number; before?: string }) {
      conn.pages++;
      clock.t += msPerCall;
      const from = opts?.before ? newest.findIndex((e) => e.signature === opts.before) + 1 : 0;
      return newest.slice(from, from + (opts?.limit ?? 1000)).map((e) => ({ signature: e.signature, blockTime: e.ts, err: null, slot: 0, memo: null }));
    },
    async getTransaction(sig: string) {
      const e = entries.find((x) => x.signature === sig);
      return e ? tx(e.logs, e.ts) : null;
    },
  };
  return conn as unknown as HistoryConn & { pages: number };
}

describe("chain history", () => {
  it("decodes recorded program logs into the tree's facts (no amounts; offers dropped)", async () => {
    const { events, partial } = await fetchHistory(E, fakeConn(recorded(), { t: 0 }), { budgetMs: 5_000 });
    expect(partial).toBe(false);
    const facts = treeEventsFromChain(events as RawChainEvent[], { estate: E, assetTitles: { [ASSET]: "2017 Toyota Corolla 1.8 Exclusive CVT" } });
    expect(facts.map((f) => f.kind)).toEqual(["EstateCreated", "ClaimSubmitted", "ClaimApproved", "SeatApproval", "ClaimPaid", "AssetRegistered", "SeatConfigured"]);
    expect(facts[0]).toMatchObject({ owner: OWNER, sig: "sig-create", ts: T0 });
    expect(facts.find((f) => f.kind === "ClaimApproved")).toMatchObject({ claim: CLAIM, verifier: ndlovu });
    expect(facts.find((f) => f.kind === "SeatApproval")).toMatchObject({ targetKind: "Claim", target: CLAIM, seat: 0 });
    expect(facts.find((f) => f.kind === "AssetRegistered")).toMatchObject({ assetKind: "Car", title: "2017 Toyota Corolla 1.8 Exclusive CVT" });
    // The empty monitor slot (the default key) is not a person.
    expect(facts.find((f) => f.kind === "SeatConfigured")).toMatchObject({ holder: bongani, monitors: [DEVNET_DEMO_GUARDIANS.zodwa] });
    expect(findAmounts(facts)).toEqual([]);
  });

  it("pages back past the feed's 40 signatures with `before`", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ signature: `s${i}`, logs: [], ts: T0 + i }));
    const conn = fakeConn(many, { t: 0 });
    const r = await historySignatures(E, conn, { pageSize: 40 });
    expect(r.complete).toBe(true);
    expect(r.signatures).toHaveLength(130);
    expect(conn.pages).toBe(4);
    expect(r.signatures[0].signature).toBe("s129"); // newest first
  });

  it("stops at the time budget and says the history is partial", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ signature: `s${i}`, logs: [], ts: T0 + i }));
    const clock = { t: 0 };
    const conn = fakeConn(many, clock, 1_000); // each page "takes" a second
    const r = await historySignatures(E, conn, { pageSize: 50, budgetMs: 3_500, now: () => clock.t });
    expect(r.complete).toBe(false);
    expect(conn.pages).toBe(4);
    expect(r.signatures).toHaveLength(200);
    const clock2 = { t: 0 };
    const h = await fetchHistory(E, fakeConn(many, clock2, 1_000), { pageSize: 50, budgetMs: 2_500, now: () => clock2.t });
    expect(h.partial).toBe(true);
  });
});

/* ---------- the tree from a devnet-like estate ---------- */

function devnetSnapshot(): EstateSnapshot {
  const kids = Object.values(DEVNET_DEMO_CHILDREN);
  return {
    estate: {
      address: E, owner: OWNER, ownerName: "Thabo Mokoena", agent: Keypair.generate().publicKey.toBase58(), usdtMint: Keypair.generate().publicKey.toBase58(),
      verifiers: [ndlovu, pillay, bongani], verifierNames: ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"],
      deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: 120, status: "Active", willHash: null, vaultBalance: 1n,
      death: { certHash: null, submittedBy: null, verdict: "Pending", attestations: [false, false, false], pendingSince: null }, lastHeartbeat: T0,
    },
    beneficiaries: kids.map((w, i) => ({ address: `ben${i}`, wallet: w, label: ["Lerato (daughter)", "Sipho (son)", "Naledi (daughter)"][i], active: true })),
    payees: [], claims: [], offers: [], hardships: [],
    rules: [{ address: RULE, id: 0, beneficiary: DEVNET_DEMO_CHILDREN.naledi, category: "Tuition", allowedPayeeKind: "School", maxPerClaim: 1n, lifetimeCap: 2n, spentTotal: 1n, validUntil: T0 + 1e8, startsNow: true, recurringAmount: 0n, intervalSecs: 0, nextDue: null, fixedPayee: null }],
    assets: [{ address: ASSET, nftMint: "HQAM3uebocQvVWCgEUJrKiUexu3DTrexL68LrwtPE6jW", title: "2017 Toyota Corolla 1.8 Exclusive CVT", floorPrice: 1n, hardshipFloor: 1n, askingPrice: 1n, proceedsTo: E, status: "Held", listingEnds: null, docHash: "0".repeat(64), hardshipBeneficiary: null }],
    activity: [],
    names: { [DEVNET_DEMO_GUARDIANS.zodwa]: "Aunt Zodwa Mokoena" },
  };
}

/** A wallet whose signMessage is a real ed25519 signature (hex), like WDK's. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  return { address, signMessage: async (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}

class Mem { data = new Map<string, string>(); getItem(k: string) { return this.data.get(k) ?? null; } setItem(k: string, v: string) { this.data.set(k, v); } }

function world(opts: { chainMode?: boolean; serverDown?: boolean; owner?: ReturnType<typeof wallet>; child?: boolean } = {}) {
  const owner = opts.owner ?? wallet();
  let acting = owner;
  const deps = { fetchRaw: async (_t: "Estate", a: string) => (a === E ? ({ owner: pk(owner.address) } as Raw) : null), now: () => Date.now(), chain: () => opts.chainMode ?? true };
  const routes = treeRoutes({ ...deps, member: async () => "member", memberOf: async () => true });
  const photos = photoRoutes({ ...deps, member: async () => "member", memberOf: async () => true });
  const calls: { method: string; status: number }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (opts.serverDown) throw new TypeError("fetch failed");
    const req = new Request(`http://local${url}`, init);
    const r = url.startsWith("/api/tree/photo") ? photos : routes;
    const res = await (init?.method === "POST" ? r.POST(req) : r.GET(req));
    calls.push({ method: init?.method ?? "GET", status: res.status });
    return res;
  }) as unknown as typeof fetch;
  const storage = new Mem();
  const childEstate = "ChiLdEsTaTe1111111111111111111111111111111";
  const svc = createChainTree({
    getEstate: async (estate) => {
      if (estate === childEstate) {
        const s = devnetSnapshot();
        return { ...s, estate: { ...s.estate, address: childEstate, owner: DEVNET_DEMO_CHILDREN.lerato }, beneficiaries: [], rules: [], assets: [], activity: [{ ts: T0 + 9000, kind: "EstateCreated", text: "" }] };
      }
      return devnetSnapshot();
    },
    history: async () => ({ events: (await fetchHistory(E, fakeConn(recorded(), { t: 0 }))).events, partial: false }),
    findEstateOf: async (w) => (opts.child && w === DEVNET_DEMO_CHILDREN.lerato ? childEstate : null),
    requireOwnerOf: (estate) => { if (estate !== E || acting.address !== owner.address) throw new Error("Switch to the estate owner's wallet to do this."); },
    signer: () => acting,
    fetch: fakeFetch, storage,
  });
  return { svc, calls, storage, owner, actAs: (w: ReturnType<typeof wallet>) => { acting = w; }, childEstate };
}

beforeEach(() => resetTreeMemory());

describe("chain getTree", () => {
  it("builds the devnet demo family: default relationships and names, generations, the real history, no amounts", async () => {
    const { svc } = world();
    const t = await svc.getTree(E);
    expect(t.mode).toBe("chain");
    expect(t.partial).toBe(false);
    expect(t.today).toBe(new Date().getUTCFullYear());
    const p = (id: string) => t.people.find((x) => x.id === id)!;
    expect(p(OWNER)).toMatchObject({ name: "Thabo Mokoena", generation: 1, ownsEstate: E });
    expect(p(DEVNET_DEMO_CHILDREN.lerato)).toMatchObject({ name: "Lerato Mokoena", generation: 2 });
    expect(p(DEVNET_DEMO_CHILDREN.naledi)).toMatchObject({ name: "Naledi", minor: true });
    expect(p("local:gogo-martha")).toMatchObject({ generation: 0, passed: 2019 });
    expect(p(DEVNET_DEMO_GUARDIANS.kagiso)).toMatchObject({ generation: 2 });
    expect(t.relationships.length).toBeGreaterThanOrEqual(10);
    // The real history: Adv. Ndlovu approved one school-fee payment for Naledi (ClaimApproved + SeatApproval = once); the plan paid it.
    expect(t.kept.find((k) => k.kind === "approvedPayments")).toMatchObject({ by: ndlovu, for: [DEVNET_DEMO_CHILDREN.naledi], count: 1, purpose: "Tuition", imagined: false, proofs: ["sig-approve"] });
    expect(t.kept.find((k) => k.kind === "planPaid")).toMatchObject({ by: OWNER, count: 1, proofs: ["sig-paid"] });
    expect(t.edges.filter((e) => e.role === "successor").map((e) => e.to).sort()).toEqual([DEVNET_DEMO_GUARDIANS.kagiso, DEVNET_DEMO_GUARDIANS.priya].sort());
    expect(t.edges.find((e) => e.role === "trustedPerson" && e.to === ndlovu)!.fromTs).toBe(T0);
    expect(t.assets).toEqual([expect.objectContaining({ kind: "Car", title: "2017 Toyota Corolla 1.8 Exclusive CVT" })]);
    expect(t.kept.every((k) => !k.imagined)).toBe(true);
    expect(findAmounts(t)).toEqual([]);
  });

  it("links a child's own plan below this one", async () => {
    const { svc, childEstate } = world({ child: true });
    const t = await svc.getTree(E);
    expect(t.generations).toEqual([{ parentEstate: E, childEstate, person: DEVNET_DEMO_CHILDREN.lerato, ts: T0 + 9000 }]);
    expect(t.people.find((p) => p.id === DEVNET_DEMO_CHILDREN.lerato)!.ownsEstate).toBe(childEstate);
  });
});

describe("relationships and hidden flags (Supabase off: server memory + this device)", () => {
  it("the owner adds and removes a relationship with a signed request; the server and this device both keep it", async () => {
    const { svc, calls, storage } = world();
    const r = await svc.setRelationship(E, { kind: "spouseOf", from: OWNER, to: DEVNET_DEMO_GUARDIANS.priya });
    expect(r.id).toBe(relationshipId("spouseOf", OWNER, DEVNET_DEMO_GUARDIANS.priya));
    expect(calls.at(-1)).toEqual({ method: "POST", status: 200 });
    expect(storage.getItem("heirloom.tree.v1")).toContain(r.id);
    expect((await svc.getTree(E)).relationships.some((x) => x.id === r.id)).toBe(true);
    // A fresh device (no local copy) still sees it from the server's memory.
    const fresh = world();
    expect((await fresh.svc.getTree(E)).relationships.some((x) => x.id === r.id)).toBe(true);
    const kagiso = relationshipId("parentOf", bongani, DEVNET_DEMO_GUARDIANS.kagiso);
    await svc.removeRelationship(E, kagiso);
    expect((await svc.getTree(E)).relationships.some((x) => x.id === kagiso)).toBe(false);
  });

  it("refuses a relationship from anyone but the owner, on the device and at the server", async () => {
    const w = world();
    const stranger = wallet();
    w.actAs(stranger);
    await expect(w.svc.setRelationship(E, { kind: "siblingOf", from: OWNER, to: bongani })).rejects.toThrow(/owner's wallet/);
    // Straight to the route with the stranger's own valid signature: 403.
    const routes = treeRoutes({ fetchRaw: async () => ({ owner: pk(w.owner.address) } as Raw), now: () => Date.now(), chain: () => true, memberOf: async () => true });
    const { treeBody, treeMessage } = await import("../tree/links");
    const { createHash } = await import("node:crypto");
    const ts = Date.now();
    const body = treeBody({ action: "relate", kind: "siblingOf", from: OWNER, to: bongani });
    const sig = await stranger.signMessage(treeMessage("relate", E, stranger.address, ts, createHash("sha256").update(body).digest("hex")));
    const res = await routes.POST(new Request("http://local/api/tree", { method: "POST", body: JSON.stringify({ action: "relate", estate: E, wallet: stranger.address, ts, sig, kind: "siblingOf", from: OWNER, to: bongani }) }));
    expect(res.status).toBe(403);
    // A forged signature (claiming the owner's wallet) is refused too.
    const forged = await routes.POST(new Request("http://local/api/tree", { method: "POST", body: JSON.stringify({ action: "relate", estate: E, wallet: w.owner.address, ts, sig, kind: "siblingOf", from: OWNER, to: bongani }) }));
    expect(forged.status).toBe(401);
  });

  it("a family member hides only themselves", async () => {
    const w = world();
    const zodwaLike = wallet();
    w.actAs(zodwaLike);
    await w.svc.setHidden(E, true);
    const links = await (await treeRoutes({ fetchRaw: async () => null, now: () => Date.now(), chain: () => true, member: async () => "member" }).GET(new Request(`http://local/api/tree?estate=${E}`))).json() as { hidden: string[] };
    expect(links.hidden).toEqual([zodwaLike.address]);
  });

  it("keeps the change on this device when the server is down or has no store (demo deployment)", async () => {
    const down = world({ serverDown: true });
    const r = await down.svc.setRelationship(E, { kind: "siblingOf", from: OWNER, to: bongani });
    const t = await down.svc.getTree(E);
    expect(t.relationships.some((x) => x.id === r.id)).toBe(true);
    expect(t.relationships.length).toBeGreaterThan(5); // the defaults still come through without the server

    const mockSite = world({ chainMode: false });
    const r2 = await mockSite.svc.setRelationship(E, { kind: "siblingOf", from: OWNER, to: DEVNET_DEMO_GUARDIANS.zodwa });
    expect(mockSite.calls.at(-1)).toEqual({ method: "POST", status: 503 });
    expect((await mockSite.svc.getTree(E)).relationships.some((x) => x.id === r2.id)).toBe(true);
  });

  it("does not let a parent become their own child's child", async () => {
    const { svc } = world();
    await expect(svc.setRelationship(E, { kind: "parentOf", from: DEVNET_DEMO_CHILDREN.lerato, to: OWNER })).rejects.toThrow(/own grandparent/);
  });
});

describe("photos (plan.md §15.11): /api/tree/photo, Supabase off (server memory) plus this device", () => {
  type W = ReturnType<typeof wallet>;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  async function signed(w: W, person: string, photo: string | null, over: { ts?: number; wallet?: string } = {}) {
    const ts = over.ts ?? Date.now();
    const sig = await w.signMessage(treeMessage("photo", E, w.address, ts, sha(treeBody({ action: "photo", person, photo }))));
    return { action: "photo", estate: E, wallet: over.wallet ?? w.address, ts, sig, person, photo };
  }
  const post = (routes: ReturnType<typeof photoRoutes>, body: unknown) => routes.POST(new Request("http://local/api/tree/photo", { method: "POST", body: JSON.stringify(body) }));
  const routesFor = (owner: W, chain = true) => photoRoutes({ fetchRaw: async (_t, a) => (a === E ? ({ owner: pk(owner.address) } as Raw) : null), now: () => Date.now(), chain: () => chain, member: async () => "member", memberOf: async () => true });
  const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

  it("the seeded devnet demo family starts with the demo site's faces (Kagiso has none)", async () => {
    const t = await world().svc.getTree(E);
    const p = (id: string) => t.people.find((x) => x.id === id)!;
    expect(p(DEVNET_DEMO_CHILDREN.lerato).photo?.src).toBe("/demo/people/lerato.webp");
    expect(p("local:mkhulu-joseph").photo).toMatchObject({ memorial: true });
    expect(p(DEVNET_DEMO_GUARDIANS.kagiso).photo).toBeUndefined();
  });

  it("the owner adds a memorial photo and a child's photo; another device sees them; the fingerprint does not change", async () => {
    const w = world();
    const before = await w.svc.getTree(E);
    const gogo = webpOf(3_000), naledi = webpOf(2_000);
    await w.svc.setPhoto(E, "local:gogo-martha", gogo);
    await w.svc.setPhoto(E, DEVNET_DEMO_CHILDREN.naledi, naledi);
    expect(w.calls.at(-1)).toEqual({ method: "POST", status: 200 });
    const fresh = await world({ owner: w.owner }).svc.getTree(E);
    const p = (id: string) => fresh.people.find((x) => x.id === id)!;
    expect(p("local:gogo-martha").photo).toMatchObject({ src: gogo, addedBy: w.owner.address, memorial: true });
    expect(p(DEVNET_DEMO_CHILDREN.naledi).photo).toMatchObject({ src: naledi, memorial: false });
    expect(fresh.fingerprint).toBe(before.fingerprint);
    await w.svc.removePhoto(E, "local:gogo-martha");
    expect((await world({ owner: w.owner }).svc.getTree(E)).people.find((x) => x.id === "local:gogo-martha")!.photo).toBeUndefined();
  });

  it("a living adult sets only their own photo; the owner cannot set a living adult's", async () => {
    const w = world();
    const zodwaLike = wallet();
    w.actAs(zodwaLike);
    const mine = webpOf(1_500);
    await w.svc.setPhoto(E, zodwaLike.address, mine);
    expect((await (await routesFor(w.owner).GET(new Request(`http://local/api/tree/photo?estate=${E}`))).json() as { photos: Record<string, { src: string }> }).photos[zodwaLike.address].src).toBe(mine);
    // Someone else's photo, or the owner's part (a child's): refused on the device.
    await expect(w.svc.setPhoto(E, OWNER, mine)).rejects.toThrow(/their own photo/);
    await expect(w.svc.setPhoto(E, DEVNET_DEMO_CHILDREN.naledi, mine)).rejects.toThrow(/their own photo/);
    w.actAs(w.owner);
    await expect(w.svc.setPhoto(E, ndlovu, mine)).rejects.toThrow(/their own photo/);
    // And at the server, with valid signatures.
    const routes = routesFor(w.owner);
    const res = await post(routes, await signed(w.owner, ndlovu, mine));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("forbidden");
    expect((await post(routes, await signed(zodwaLike, DEVNET_DEMO_CHILDREN.naledi, mine))).status).toBe(403);
    expect((await post(routes, await signed(zodwaLike, "local:mkhulu-joseph", null))).status).toBe(403);
  });

  it("refuses a stale request, a replayed one and a forged signer", async () => {
    const owner = wallet();
    const routes = routesFor(owner);
    const pic = webpOf(800);
    const stale = await post(routes, await signed(owner, "local:gogo-martha", pic, { ts: Date.now() - 6 * 60_000 }));
    expect(stale.status).toBe(401);
    expect(await code(stale)).toBe("stale");
    const body = await signed(owner, "local:gogo-martha", pic);
    expect((await post(routes, body)).status).toBe(200);
    const again = await post(routes, body);
    expect(again.status).toBe(401);
    expect(await code(again)).toBe("replay");
    // A stranger signs, but claims to be the owner's wallet.
    const stranger = wallet();
    const forged = await post(routes, await signed(stranger, "local:gogo-martha", pic, { wallet: owner.address }));
    expect(forged.status).toBe(401);
    expect(await code(forged)).toBe("unauthorized");
    // The signature covers the photo: swapping in another image breaks it.
    const swapped = { ...(await signed(owner, "local:gogo-martha", pic)), photo: webpOf(900) };
    expect((await post(routes, swapped)).status).toBe(401);
  });

  it("refuses a photo over 60 KB (413) or not WebP (415), on the device and at the server", async () => {
    const owner = wallet();
    const routes = routesFor(owner);
    const big = await post(routes, await signed(owner, "local:gogo-martha", webpOf(61 * 1024)));
    expect(big.status).toBe(413);
    const png = `data:image/png;base64,${Buffer.from("\x89PNG\r\n\x1a\n00000000", "latin1").toString("base64")}`;
    const wrong = await post(routes, await signed(owner, "local:gogo-martha", png));
    expect(wrong.status).toBe(415);
    const disguised = await post(routes, await signed(owner, "local:gogo-martha", png.replace("image/png", "image/webp")));
    expect(disguised.status).toBe(415);
    // A body far past the limit never reaches the parser.
    expect((await post(routes, { ...(await signed(owner, "local:gogo-martha", null)), photo: "A".repeat(200_000) })).status).toBe(413);
    const w = world({ owner });
    await expect(w.svc.setPhoto(E, "local:gogo-martha", webpOf(61 * 1024))).rejects.toThrow(/60 KB/);
    await expect(w.svc.setPhoto(E, "local:gogo-martha", png)).rejects.toThrow(/WebP/);
  });

  it("never stores or shows a photo for a hidden person", async () => {
    const w = world();
    const hider = wallet();
    w.actAs(hider);
    await w.svc.setPhoto(E, hider.address, webpOf(500));
    await w.svc.setHidden(E, true);
    await expect(w.svc.setPhoto(E, hider.address, webpOf(600))).rejects.toThrow(/hide/);
    const res = await post(routesFor(w.owner), await signed(hider, hider.address, webpOf(600)));
    expect(res.status).toBe(403);
  });

  it("on the demo deployment the route answers 503 and the photo is kept on this device", async () => {
    const owner = wallet();
    expect((await post(routesFor(owner, false), await signed(owner, "local:gogo-martha", webpOf(500)))).status).toBe(503);
    const mockSite = world({ chainMode: false, owner });
    const pic = webpOf(700);
    await mockSite.svc.setPhoto(E, "local:gogo-martha", pic);
    expect(mockSite.calls.at(-1)).toEqual({ method: "POST", status: 503 });
    expect((await mockSite.svc.getTree(E)).people.find((x) => x.id === "local:gogo-martha")!.photo?.src).toBe(pic);
    expect(mockSite.storage.getItem("heirloom.tree.photos.v1")).toContain("local:gogo-martha");
  });
});
