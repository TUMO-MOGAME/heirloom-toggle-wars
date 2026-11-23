/**
 * Plan §18.3 S4: names survive a server restart. The real route (with a memory store that can "restart") and the
 * owner's device keeper, with real ed25519 signatures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import type { EstateMeta } from "../db";
import { estateMetaRoutes, type EstateMetaRouteDeps } from "./route";
import { createNamesKeeper, namesFromDevice, type DeviceNames } from "./keeper";
import { signedMetaRequest } from "./signed";
import { fillGaps, newestNames, type Names } from "./merge";

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const signMessage = vi.fn(async (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex"));
  return { address, signMessage };
}

const E = "EsTaTeTeStAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AUNT = "AuNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NEPHEW = "NePHewAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NAMES: Names = {
  ownerName: "Thabo Mokoena", verifierNames: ["Adv. Ndlovu", "Ms. Pillay", "Uncle Bongani"],
  assetTitles: { title: "2017 Corolla" }, buyerNames: { [AUNT]: "Aunt Zodwa" },
};
const ROLES: Names = { ownerName: "Estate owner", verifierNames: ["Verifier 1", "Verifier 2", "Verifier 3"], assetTitles: {}, buyerNames: {} };
const T0 = Date.UTC(2026, 10, 27, 9);

let owner: ReturnType<typeof wallet>;
let active: ReturnType<typeof wallet>;
let quiet: boolean | undefined;
let clock: number;
let server: Map<string, EstateMeta>;
let routes: ReturnType<typeof estateMetaRoutes>;
let disk: Map<string, string>;
let posts: number;
let ip = 0;

const routeDeps = (): EstateMetaRouteDeps => ({
  chain: () => true, now: () => clock, member: async () => owner.address,
  estate: async () => ({ owner: owner.address, willHash: null }),
  hasOffer: async () => true,
  get: async (e) => server.get(e) ?? null,
  save: async (m, prev) => {
    if ((server.get(m.estate) ?? null) !== prev) return false;
    server.set(m.estate, m);
    return true;
  },
  saveDraft: async () => undefined,
});

/** A serverless restart: memory gone. */
function restart() {
  server = new Map();
  routes = estateMetaRoutes(routeDeps());
}

async function post(body: Record<string, unknown>) {
  posts++;
  const res = await routes.POST(new Request("http://t/api/estate-meta", {
    method: "POST", headers: { "x-forwarded-for": `10.1.${(++ip >> 8) & 255}.${ip & 255}` }, body: JSON.stringify(body),
  }));
  const data = (await res.json()) as { saved?: boolean; updatedAt?: number; code?: string };
  if (!res.ok) throw new Error(data.code);
  return data;
}

const keeperOn = (store: Map<string, string>) => createNamesKeeper({
  signer: () => ({ ...active, canSignQuietly: quiet === undefined ? undefined : () => quiet! }),
  owns: (estate, address) => estate === E && address === owner.address,
  post,
  storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }),
  now: () => clock,
});
let keeper: ReturnType<typeof keeperOn>;

const device = (over: Partial<DeviceNames> = {}): DeviceNames => ({
  estate: { owner: owner.address, verifiers: ["v0", "v1", "v2"] }, names: {}, labels: {}, people: [AUNT], ...over,
});

/** The owner saves, as chain.ts does: copy first, then the signed write. */
async function ownerSaves(names: Names, on = keeper, base: EstateMeta | null = server.get(E) ?? null) {
  const meta = { estate: E, ownerWallet: owner.address, ...names, updatedAt: base?.updatedAt };
  on.remember(meta);
  const { updatedAt } = await post(await signedMetaRequest(owner, "save", E, { ...names, basedOn: base?.updatedAt ?? 0 }, clock));
  on.remember(meta, updatedAt);
  owner.signMessage.mockClear();
}

beforeEach(() => {
  owner = wallet();
  active = owner;
  quiet = true;
  clock = T0;
  disk = new Map();
  posts = 0;
  restart();
  keeper = keeperOn(disk);
});

describe("the owner's device restores what the server lost", () => {
  it("after a restart: shown at once, and put back by the owner's signature", async () => {
    await ownerSaves(NAMES);
    restart();
    expect(keeper.view(E, null)).toMatchObject(NAMES);
    expect(await keeper.sync(E, null, device())).toBe(true);
    expect(server.get(E)).toMatchObject({ ...NAMES, ownerWallet: owner.address });
    expect(owner.signMessage).toHaveBeenCalledTimes(1);
  });

  it("signs nothing when the server has everything", async () => {
    await ownerSaves(NAMES);
    posts = 0;
    expect(await keeper.sync(E, server.get(E)!, device())).toBe(false);
    expect([posts, owner.signMessage.mock.calls.length]).toEqual([0, 0]);
  });

  it("names this device already had before the copy existed are put back too", async () => {
    expect(await keeper.sync(E, null, device({ labels: { [owner.address]: "Thabo" }, names: { v1: "Ms. Pillay", [AUNT]: "Aunt Zodwa" } }))).toBe(true);
    expect(server.get(E)).toMatchObject({
      ownerName: "Thabo", verifierNames: ["Verifier 1", "Ms. Pillay", "Verifier 3"], buyerNames: { [AUNT]: "Aunt Zodwa" },
    });
  });

  it("never carries another family's names into this one", () => {
    expect(namesFromDevice(device({ names: { [AUNT]: "Aunt Zodwa", [NEPHEW]: "Someone else's nephew" } })).buyerNames).toEqual({ [AUNT]: "Aunt Zodwa" });
  });

  it("nothing known: nothing sent", async () => {
    expect(await keeper.sync(E, null, device())).toBe(false);
    expect(posts).toBe(0);
  });
});

describe("never an unexpected PIN prompt", () => {
  it.each([["locked", false], ["can't say (a wallet without the check)", undefined]] as const)("a wallet that is %s is never asked", async (_what, state) => {
    await ownerSaves(NAMES);
    restart();
    quiet = state;
    posts = 0;
    expect(await keeper.sync(E, null, device())).toBe(false);
    expect([posts, owner.signMessage.mock.calls.length]).toEqual([0, 0]);
    expect(keeper.view(E, null)).toMatchObject(NAMES);
  });

  it("restores on the load after it is unlocked", async () => {
    await ownerSaves(NAMES);
    restart();
    quiet = false;
    await keeper.sync(E, null, device());
    quiet = true;
    expect(await keeper.sync(E, null, device())).toBe(true);
  });

  it("locked while the request was being built: not signed", async () => {
    await ownerSaves(NAMES);
    restart();
    let asked = 0;
    const racing = createNamesKeeper({
      signer: () => ({ ...owner, canSignQuietly: () => asked++ === 0 }),
      owns: () => true, post, now: () => clock,
      storage: () => ({ getItem: (k) => disk.get(k) ?? null, setItem: (k, v) => void disk.set(k, v) }),
    });
    expect(await racing.sync(E, null, device())).toBe(false);
    expect(owner.signMessage).not.toHaveBeenCalled();
  });

  it("a failing restore is tried at most once a minute", async () => {
    await ownerSaves(NAMES);
    routes = estateMetaRoutes({ ...routeDeps(), chain: () => false });
    posts = 0;
    await keeper.sync(E, null, device());
    await keeper.sync(E, null, device());
    expect(posts).toBe(1);
    clock += 60_001;
    await keeper.sync(E, null, device());
    expect(posts).toBe(2);
  });
});

describe("never overwrites newer server data with an older copy", () => {
  it("an old device's restore fills gaps only", async () => {
    await ownerSaves(NAMES);
    const oldDevice = keeperOn(new Map(disk));
    clock += 60_000;
    const other = keeperOn(new Map());
    await ownerSaves({ ...NAMES, ownerName: "Thabo J. Mokoena", buyerNames: { [NEPHEW]: "Sipho" } }, other);

    expect(oldDevice.view(E, server.get(E)!)?.ownerName).toBe("Thabo J. Mokoena");
    expect(await oldDevice.sync(E, server.get(E)!, device())).toBe(true);
    expect(server.get(E)?.ownerName).toBe("Thabo J. Mokoena");
    expect(server.get(E)?.buyerNames).toEqual({ [NEPHEW]: "Sipho", [AUNT]: "Aunt Zodwa" });
  });

  it("a restore can't replace a stored value, even claiming to be newer", async () => {
    await ownerSaves(NAMES);
    await post(await signedMetaRequest(owner, "save", E, { ...NAMES, ownerName: "Other", restoredFrom: clock + 10 }, clock + 10));
    expect(server.get(E)?.ownerName).toBe("Thabo Mokoena");
  });

  it("a save built on older names is refused (409)", async () => {
    await ownerSaves(NAMES);
    const read = server.get(E)!;
    clock += 10_000;
    await ownerSaves({ ...NAMES, ownerName: "Newer" });
    clock += 10_000;
    await expect(ownerSaves({ ...NAMES, ownerName: "Built on the older one" }, keeper, read)).rejects.toThrow("stale");
    expect(server.get(E)?.ownerName).toBe("Newer");
  });

  it("a save built on no names doesn't replace names that are there (a failed read)", async () => {
    await ownerSaves(NAMES);
    clock += 10_000;
    await expect(ownerSaves({ ...NAMES, ownerName: "Built on nothing" }, keeper, null)).rejects.toThrow("stale");
  });

  it("a save that was refused leaves the server's newer names showing, plus what was added", async () => {
    await ownerSaves(NAMES);
    const read = server.get(E)!;
    const other = keeperOn(new Map());
    clock += 10_000;
    await ownerSaves({ ...NAMES, ownerName: "Newer" }, other);
    clock += 10_000;
    await expect(ownerSaves({ ...NAMES, buyerNames: { ...NAMES.buyerNames, [NEPHEW]: "Sipho" } }, keeper, read)).rejects.toThrow("stale");
    const shown = keeper.view(E, server.get(E)!)!;
    expect(shown.ownerName).toBe("Newer");
    expect(shown.buyerNames[NEPHEW]).toBe("Sipho");
  });

  it("a store that changed between read and write refuses", async () => {
    routes = estateMetaRoutes({ ...routeDeps(), save: async () => false });
    await expect(ownerSaves(NAMES)).rejects.toThrow("stale");
  });

  it("a store that can't be read is never taken for an empty one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    routes = estateMetaRoutes({ ...routeDeps(), get: async () => { throw new Error("db down"); } });
    await expect(ownerSaves(NAMES)).rejects.toThrow();
    expect(server.size).toBe(0);
  });

  it("the redacted view never replaces real names on the device", async () => {
    await ownerSaves(NAMES);
    await keeper.sync(E, { estate: E, ownerWallet: owner.address, ...ROLES }, device());
    expect(keeper.view(E, null)).toMatchObject(NAMES);
  });
});

describe("only the owner", () => {
  it("another wallet on the same device neither sees the copy nor sends it", async () => {
    await ownerSaves(NAMES);
    restart();
    active = wallet();
    posts = 0;
    expect(keeper.view(E, null)).toBeNull();
    expect(await keeper.sync(E, null, device())).toBe(false);
    expect(posts).toBe(0);
  });

  it("the server refuses a restore signed by anyone else", async () => {
    await expect(post(await signedMetaRequest(wallet(), "save", E, { ...NAMES, restoredFrom: clock }, clock))).rejects.toThrow("forbidden");
  });

  it("broken or blocked storage is just no copy", async () => {
    disk.set("heirloom.names.v1", "{not json");
    expect(keeper.view(E, null)).toBeNull();
    const blocked = createNamesKeeper({ signer: () => owner, owns: () => true, post, storage: () => { throw new Error("blocked"); } });
    expect(blocked.view(E, null)).toBeNull();
    expect(() => blocked.remember({ estate: E, ownerWallet: owner.address, ...NAMES })).not.toThrow();
  });
});

describe("merge", () => {
  it("a role counts as no name", () => {
    expect(fillGaps(ROLES, NAMES)).toEqual({ names: NAMES, changed: true });
    expect(fillGaps(NAMES, ROLES)).toEqual({ names: NAMES, changed: false });
  });

  it("the newer wins a disagreement, and both keep what only they have", () => {
    const b = { ...NAMES, ownerName: "B", buyerNames: { [NEPHEW]: "Sipho" } };
    expect(newestNames({ names: NAMES, at: 1 }, { names: b, at: 2 })).toMatchObject({ ownerName: "B", buyerNames: { [AUNT]: "Aunt Zodwa", [NEPHEW]: "Sipho" } });
    expect(newestNames({ names: NAMES, at: 2 }, { names: b, at: 2 }).ownerName).toBe("Thabo Mokoena");
  });
});

describe("whether storage is durable", () => {
  it.each([true, false])("GET with no estate says durable: %s", async (durable) => {
    const res = await estateMetaRoutes({ ...routeDeps(), durable: () => durable }).GET(new Request("http://t/api/estate-meta"));
    expect(await res.json()).toEqual({ durable });
  });

  it("the client reads it, and shows nothing when it can't", async () => {
    vi.resetModules();
    const { namesAreDurable } = await import("./storage-status");
    expect(await namesAreDurable((async () => new Response("no", { status: 500 })) as typeof fetch)).toBeNull();
    expect(await namesAreDurable((async () => Response.json({ durable: false })) as typeof fetch)).toBe(false);
  });

  it("the notice is in four languages", async () => {
    const { continuity } = await import("@/content/continuity");
    const texts = Object.values(continuity).map((c) => c.names.notDurable);
    expect(new Set(texts).size).toBe(4);
  });

  it("the notice is on every form where names are typed", () => {
    for (const f of ["screens/will", "screens/people", "guardians/people-editor", "guardians/fallback", "guardians/replace-seat", "everyday/bill-sheet"]) {
      expect(readFileSync(path.resolve(process.cwd(), `src/components/${f}.tsx`), "utf8"), f).toContain("<NamesNotice");
    }
  });
});
