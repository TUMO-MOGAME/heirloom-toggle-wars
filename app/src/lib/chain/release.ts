/**
 * Is the deployed program the one this build was made for? (plan §18.9 C1). Browser-safe.
 *
 * A build carries its IDL; the chain carries a program. When they differ, writes are encoded for one program and run
 * by another: add_rule's new first argument shifted every value 65,536 times, and appended accounts were silently
 * ignored. So every write, and /api/health, needs both of these to hold:
 *  - release.json pins the IDL (by hash) to one deployment of the program: the slot it was last deployed or extended
 *    in, from the program's ProgramData account. Only the upgrade authority can change that account, and any upgrade
 *    changes the slot, so it can't be spoofed and it is one small read. The pin names no instruction.
 *  - the chain's ProgramData slot is the pinned one.
 * release.json is written by scripts/pin-program.ts after the upgrade, which first checks the deployed bytes against
 * the built binary. Until then nothing is pinned and every write fails closed. Localnet (surfpool, a test validator)
 * is never pinned and is not checked.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import rawIdl from "./idl/heirloom.json";
import release from "./release.json";
import { chainConfig } from "./config";
import { getIdl } from "./idl";
import { hashJson } from "../agent/hash";

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** UpgradeableLoaderState::ProgramData: u32 tag (3), u64 slot, then the authority. */
const PROGRAM_DATA_TAG = 3;
export const PROGRAM_DATA_HEADER = 45;

export interface Release {
  cluster: string;
  programId: string;
  idlSha256: string | null;
  deploySlot: number | null;
  binarySha256?: string | null;
  binaryBytes?: number | null;
}

export const RELEASE: Release = release;

let idlHash: Promise<string> | null = null;
/** SHA-256 of the canonical JSON of the bundled IDL (its `address` included, as built). */
export const bundledIdlSha256 = () => (idlHash ??= hashJson(rawIdl));

export const programDataAddress = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([programId.toBytes()], BPF_UPGRADEABLE_LOADER)[0];

/** The slot a ProgramData account was last deployed in, or null when the account is not one. */
export function deploySlot(info: Pick<AccountInfo<Uint8Array>, "owner" | "data"> | null): number | null {
  if (!info || !info.owner.equals(BPF_UPGRADEABLE_LOADER) || info.data.length < 12) return null;
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  if (view.getUint32(0, true) !== PROGRAM_DATA_TAG) return null;
  return Number(view.getBigUint64(4, true));
}

/**
 * Which build this is: the pinned deployment and, on Vercel, the commit. A tab whose build differs from the server's
 * is older (or newer) than what the server runs, and is asked to reload before it writes.
 */
export const APP_BUILD = `${RELEASE.deploySlot ?? "unpinned"}:${process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? ""}`;

export type ReleaseProblem = "unpinned" | "cluster" | "program" | "idl" | "deployment" | "unreadable";

interface SlotReader {
  getAccountInfo(key: PublicKey, config: { commitment: "confirmed"; dataSlice: { offset: number; length: number } }): Promise<AccountInfo<Buffer | Uint8Array> | null>;
}

/** Null when the deployed program is the pinned one; else what is wrong. Never throws. */
export async function releaseProblem(conn: SlotReader, pin: Release = RELEASE, cluster = chainConfig.cluster): Promise<ReleaseProblem | null> {
  if (cluster === "localnet") return null;
  if (pin.deploySlot === null || pin.idlSha256 === null) return "unpinned";
  if (pin.cluster !== cluster) return "cluster";
  const programId = getIdl().address;
  if (pin.programId !== programId) return "program";
  if ((await bundledIdlSha256()) !== pin.idlSha256) return "idl";
  let info: AccountInfo<Buffer | Uint8Array> | null;
  try {
    info = await conn.getAccountInfo(programDataAddress(new PublicKey(programId)), { commitment: "confirmed", dataSlice: { offset: 0, length: 12 } });
  } catch {
    return "unreadable";
  }
  return deploySlot(info) === pin.deploySlot ? null : "deployment";
}

export const RELEASE_WORDS: Record<ReleaseProblem, string> = {
  unpinned: "this version of the app is not yet released for the Heirloom program on this network",
  cluster: "this version of the app was released for another network",
  program: "this version of the app was released for another Heirloom program",
  idl: "this version of the app was built for another version of the Heirloom program",
  deployment: "the Heirloom program on the network is not the version this app was made for (it is being updated)",
  unreadable: "the network could not be asked which version of the Heirloom program it runs",
};

/**
 * For scripts/pin-program.ts: whether a ProgramData account holds exactly this built binary (the bytes after the
 * header, then nothing but zeros), and the pin to write when it does.
 */
export function holdsBinary(programData: Uint8Array, binary: Uint8Array): boolean {
  if (programData.length < PROGRAM_DATA_HEADER + binary.length) return false;
  for (let i = 0; i < binary.length; i++) if (programData[PROGRAM_DATA_HEADER + i] !== binary[i]) return false;
  for (let i = PROGRAM_DATA_HEADER + binary.length; i < programData.length; i++) if (programData[i] !== 0) return false;
  return true;
}

export async function pinFor(p: {
  cluster: string; programData: AccountInfo<Uint8Array> | null; binary: Uint8Array; binarySha256: string; idlSha256?: string;
}): Promise<Release> {
  const slot = deploySlot(p.programData);
  if (slot === null) throw new Error("That is not the program's ProgramData account.");
  if (!holdsBinary(p.programData!.data, p.binary)) throw new Error("The deployed program is not this binary: nothing was pinned.");
  return {
    cluster: p.cluster, programId: getIdl().address, idlSha256: p.idlSha256 ?? (await bundledIdlSha256()), deploySlot: slot,
    binarySha256: p.binarySha256, binaryBytes: p.binary.length,
  };
}
