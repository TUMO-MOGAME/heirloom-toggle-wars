/**
 * The owner's device keeps a copy of their estate's names, and puts back what the server lost (plan §18.3 S4: without
 * Supabase the server keeps names in memory, so a restart loses them). Names are never put on-chain.
 *
 * - The copy is kept and shown only for the estate's owner, while that wallet is the active one.
 * - Putting back is the ordinary owner-signed save marked `restoredFrom`; the server then only fills gaps, so an older
 *   device can't replace anything newer there.
 * - It happens in the background only when signing asks for nothing (`canSignQuietly`, as for letters): a locked
 *   wallet or a phone wallet never gets a PIN sheet or an app switch because a page loaded.
 */
import type { Base58 } from "../types";
import type { EstateMeta } from "../db";
import { signedMetaRequest, type MetaSigner } from "./signed";
import { fillGaps, hasNames, namesOf, newestNames, OWNER_ROLE, verifierRole, type Names } from "./merge";

const KEY = "heirloom.names.v1";
const RETRY_MS = 60_000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
interface Copy { owner: Base58; savedAt: number; names: Names }

export interface KeeperSigner extends MetaSigner { canSignQuietly?(): boolean }

/** What an older device already holds: wallet labels and the names kept by guardians. */
export interface DeviceNames { estate: { owner: Base58; verifiers: readonly Base58[] }; names: Record<Base58, string>; labels: Record<Base58, string>; people: unknown }

export interface KeeperDeps {
  signer(): KeeperSigner | null;
  /** True when `wallet` owns `estate` (the estate's address is derived from its owner). */
  owns(estate: Base58, wallet: Base58): boolean;
  post(body: Record<string, unknown>): Promise<{ saved?: boolean }>;
  /** null = no device storage. */
  storage(): Storage | null;
  now?(): number;
}

const isRecord = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

function isCopy(v: unknown): v is Copy {
  const c = v as Copy;
  return isRecord(c) && typeof c.owner === "string" && typeof c.savedAt === "number" && isRecord(c.names)
    && typeof c.names.ownerName === "string" && Array.isArray(c.names.verifierNames) && c.names.verifierNames.length === 3
    && isRecord(c.names.assetTitles) && isRecord(c.names.buyerNames);
}

/**
 * The names this device can give an estate kept from before the copy existed. Only people in this estate: the
 * device's list covers every family on it, and another family's names must not travel.
 */
export function namesFromDevice(d: DeviceNames): Names {
  const inEstate = JSON.stringify([d.estate, d.people], (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return {
    ownerName: (d.labels[d.estate.owner] ?? OWNER_ROLE).slice(0, 80),
    verifierNames: [0, 1, 2].map((i) => {
      const wallet = d.estate.verifiers[i];
      return (d.names[wallet] ?? d.labels[wallet] ?? verifierRole(i)).slice(0, 64);
    }) as Names["verifierNames"],
    assetTitles: {},
    buyerNames: Object.fromEntries(
      Object.entries(d.names).filter(([wallet, name]) => name && inEstate.includes(`"${wallet}"`)).map(([wallet, name]) => [wallet, name.slice(0, 64)]),
    ),
  };
}

export function createNamesKeeper(d: KeeperDeps) {
  const now = d.now ?? (() => Date.now());
  const tried = new Map<Base58, number>();

  function ownerOf(estate: Base58): KeeperSigner | null {
    const signer = d.signer();
    return signer && d.owns(estate, signer.address) ? signer : null;
  }

  function all(): Record<Base58, unknown> {
    try {
      const parsed: unknown = JSON.parse(d.storage()?.getItem(KEY) ?? "{}");
      return isRecord(parsed) ? (parsed as Record<Base58, unknown>) : {};
    } catch { return {}; }
  }

  function read(estate: Base58, owner: Base58): Copy | null {
    const copy = all()[estate];
    return isCopy(copy) && copy.owner === owner ? copy : null;
  }

  function write(estate: Base58, copy: Copy): void {
    try {
      const next = JSON.stringify({ ...all(), [estate]: copy });
      const storage = d.storage();
      if (storage && storage.getItem(KEY) !== next) storage.setItem(KEY, next);
    } catch { /* storage blocked or full: the server's copy is the only one */ }
  }

  /**
   * The names to show and to build a save on: the server's and this device's together, the newer winning. Keeps the
   * server's `updatedAt`, which a save sends back so it can't replace something newer.
   */
  function view(estate: Base58, server: EstateMeta | null): EstateMeta | null {
    const owner = ownerOf(estate);
    const copy = owner && read(estate, owner.address);
    if (!owner || !copy) return server;
    if (!server) return { estate, ownerWallet: owner.address, ...copy.names, updatedAt: 0 };
    return { ...server, ...newestNames({ names: namesOf(server), at: server.updatedAt ?? 0 }, { names: copy.names, at: copy.savedAt }) };
  }

  /** Before a save is sent, so a refused or lost request still leaves the names here. */
  function remember(meta: EstateMeta, savedAt?: number): void {
    const owner = ownerOf(meta.estate);
    if (!owner) return;
    const old = read(meta.estate, owner.address);
    // Built on both copies, so newer than both.
    const at = savedAt ?? Math.max(old?.savedAt ?? 0, meta.updatedAt ?? 0) + 1;
    const names = old ? newestNames({ names: namesOf(meta), at }, { names: old.names, at: old.savedAt }) : namesOf(meta);
    write(meta.estate, { owner: owner.address, savedAt: at, names });
  }

  /**
   * On every load of the owner's estate: brings the copy up to date and, quietly, puts back what the server lacks.
   * Resolves true when the server took something.
   */
  async function sync(estate: Base58, server: EstateMeta | null, device: DeviceNames): Promise<boolean> {
    const owner = ownerOf(estate);
    if (!owner || device.estate.owner !== owner.address) return false;
    const old = read(estate, owner.address);
    const known = view(estate, server);
    const names = fillGaps(known ? namesOf(known) : null, namesFromDevice(device)).names;
    if (!hasNames(names)) return false;
    const savedAt = Math.max(old?.savedAt ?? 0, server?.updatedAt ?? 0);
    write(estate, { owner: owner.address, savedAt, names });

    if (!fillGaps(server ? namesOf(server) : null, names).changed) return false;
    if (owner.canSignQuietly?.() !== true) return false;
    const last = tried.get(estate);
    if (last !== undefined && now() - last < RETRY_MS) return false;
    tried.set(estate, now());

    const quiet: MetaSigner = {
      address: owner.address,
      signMessage: async (message) => {
        // Asked again at the last moment: the wallet may have been locked while the request was being built.
        if (owner.canSignQuietly?.() !== true) throw new Error("The wallet is locked.");
        return owner.signMessage(message);
      },
    };
    try {
      const body = await signedMetaRequest(quiet, "save", estate, { ...names, restoredFrom: savedAt }, now());
      return (await d.post(body)).saved === true;
    } catch {
      return false; // the copy stays here for the next load
    }
  }

  return { view, remember, sync };
}
