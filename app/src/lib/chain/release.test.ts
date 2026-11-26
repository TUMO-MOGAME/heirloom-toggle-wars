/**
 * Plan §18.9 C1: this app on another version of the program (or an old tab on a new one) wrote corrupted rules. Writes
 * (sponsored, self-paid, the agent's) and /api/health now fail closed unless the deployed program is the pinned one.
 * The chain is a fake RPC holding a real ProgramData layout; nothing else about the check is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ accounts: new Map<string, { owner: unknown; data: Buffer; lamports: number; executable: boolean }>(), reads: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("./tx", async (original: () => Promise<object>) => ({
  ...(await original()),
  getConnection: () => ({
    getAccountInfo: async (k: PublicKey, o?: { dataSlice?: { offset: number; length: number } }) => {
      h.reads++;
      const a = h.accounts.get(k.toBase58());
      if (!a) return null;
      return o?.dataSlice ? { ...a, data: a.data.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) } : a;
    },
    getBalance: async () => 0,
  }),
}));
vi.mock("@/lib/api/http", async (original: () => Promise<object>) => ({ ...(await original()), isChainMode: () => true }));
vi.mock("./config", async (original: () => Promise<{ chainConfig: object }>) => {
  const m = await original();
  return { ...m, chainConfig: { ...m.chainConfig, dataMode: "chain", cluster: "devnet" } };
});

const { getIdl } = await import("./idl");
const {
  APP_BUILD, BPF_UPGRADEABLE_LOADER, PROGRAM_DATA_HEADER, RELEASE, bundledIdlSha256, deploySlot, holdsBinary, pinFor, programDataAddress, releaseProblem,
} = await import("./release");
const { forgetProgramCheck, assertProgram } = await import("../server/program");
const { forgetWriteGuard, requireCurrentApp } = await import("./write-guard");

const programId = new PublicKey(getIdl().address);
const SLOT = 431_000_123;
const binary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 0, 0]);

function programData(slot = SLOT, bytes = binary, owner: PublicKey = BPF_UPGRADEABLE_LOADER, spare = 16) {
  const data = Buffer.alloc(PROGRAM_DATA_HEADER + bytes.length + spare);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(BigInt(slot), 4);
  data.set(bytes, PROGRAM_DATA_HEADER);
  return { owner, data, lamports: 1, executable: false };
}
const deploy = (slot = SLOT, owner?: PublicKey) => h.accounts.set(programDataAddress(programId).toBase58(), programData(slot, binary, owner));
const conn = ({ getAccountInfo: async (k: PublicKey, o: { dataSlice: { offset: number; length: number } }) => {
  const a = h.accounts.get(k.toBase58());
  return a ? { ...a, data: a.data.subarray(o.dataSlice.offset, o.dataSlice.offset + o.dataSlice.length) } : null;
} }) as unknown as Parameters<typeof releaseProblem>[0];
const pinned = async (over: Partial<typeof RELEASE> = {}) =>
  ({ ...RELEASE, idlSha256: await bundledIdlSha256(), deploySlot: SLOT, ...over });

beforeEach(() => {
  h.accounts.clear();
  h.reads = 0;
  forgetProgramCheck();
  forgetWriteGuard();
});

describe("the pin", () => {
  it("is the deployment's slot, read from a real ProgramData layout, and nothing else", () => {
    expect(deploySlot(programData())).toBe(SLOT);
    expect(deploySlot(programData(SLOT, binary, Keypair.generate().publicKey))).toBeNull();
    expect(deploySlot(null)).toBeNull();
  });

  it("matches only the deployment it was made from", async () => {
    deploy();
    expect(await releaseProblem(conn, await pinned())).toBeNull();
    deploy(SLOT + 1); // any upgrade (or an extension) changes the slot
    expect(await releaseProblem(conn, await pinned())).toBe("deployment");
    deploy(SLOT, Keypair.generate().publicKey); // an account that only looks like ProgramData
    expect(await releaseProblem(conn, await pinned())).toBe("deployment");
  });

  it("is refused for another IDL, program or network, and when nothing is pinned", async () => {
    deploy();
    expect(await releaseProblem(conn, await pinned({ idlSha256: "00".repeat(32) }))).toBe("idl");
    expect(await releaseProblem(conn, await pinned({ programId: Keypair.generate().publicKey.toBase58() }))).toBe("program");
    expect(await releaseProblem(conn, await pinned({ cluster: "mainnet-beta" }))).toBe("cluster");
    expect(await releaseProblem(conn, { ...RELEASE, deploySlot: null })).toBe("unpinned");
    expect(await releaseProblem(conn, await pinned(), "localnet")).toBeNull();
  });

  it("names no instruction, so renaming add_rule can't open it", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/lib/chain/release.ts"), "utf8");
    expect(source).not.toMatch(/findInstruction|getIdl().instructions|["'`]add_rule/);
  });

  it("is committed unpinned until the release step pins it", () => {
    expect(RELEASE.programId).toBe(programId.toBase58());
    if (RELEASE.deploySlot === null) expect(RELEASE.idlSha256).toBeNull();
  });

  it("is written only for a deployment that holds exactly the built binary", async () => {
    const pin = await pinFor({ cluster: "devnet", programData: programData(), binary, binarySha256: "ab" });
    expect(pin).toMatchObject({ deploySlot: SLOT, idlSha256: await bundledIdlSha256(), binaryBytes: binary.length, programId: programId.toBase58() });
    expect(holdsBinary(programData(SLOT, new Uint8Array([...binary.slice(0, -1), 9])).data, binary)).toBe(false);
    const trailing = programData();
    trailing.data[trailing.data.length - 1] = 1;
    expect(holdsBinary(trailing.data, binary)).toBe(false);
    await expect(pinFor({ cluster: "devnet", programData: null, binary, binarySha256: "ab" })).rejects.toThrow(/ProgramData/);
  });
});

// The fake chain deploys at SLOT, never the pinned slot: an unpinned build says "unpinned", a pinned one "deployment".
describe("the server fails closed (this build is unpinned, or pinned to another deployment)", () => {
  it("nothing the agent signs: assertProgram, and agentSignAndSend before any key is opened", async () => {
    deploy();
    await expect(assertProgram()).rejects.toMatchObject({ status: 503, code: "program_mismatch" });
    const { agentSignAndSend } = await import("../agent/agent-wallet");
    const { reviewDeath } = await import("./instructions");
    await expect(agentSignAndSend([reviewDeath(Keypair.generate().publicKey, Keypair.generate().publicKey, "Approve", "11".repeat(32), "22".repeat(32))]))
      .rejects.toMatchObject({ code: "program_mismatch" });
  });

  it("the sponsor co-signs nothing", async () => {
    vi.stubEnv("AGENT_SEED_PHRASE", "stand-in words for a test only");
    vi.stubEnv("NEXT_PUBLIC_USDT_MINT", "8qp8uFHeJMgwQPWCYAKh9mpYw6FgU4iwu6psKiKViKK5");
    try {
      const { agentCoSign } = await import("../agent/agent-wallet");
      await expect(agentCoSign("AA==")).rejects.toMatchObject({ code: "program_mismatch" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("/api/health is not ok, and says why", async () => {
    deploy();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request("http://t/api/health", { headers: { "x-forwarded-for": "203.0.113.50" } }));
    expect(res.status).toBe(503);
    expect(RELEASE.deploySlot).not.toBe(SLOT);
    // A build whose IDL is newer than the pin (a program upgrade waiting for its release) says "idl".
    const problem = RELEASE.deploySlot === null ? "unpinned" : (await bundledIdlSha256()) !== RELEASE.idlSha256 ? "idl" : "deployment";
    expect(await res.json()).toMatchObject({ ok: false, programCurrent: false, programProblem: problem });
  });

  it("the check is one small read, shared for a few seconds", async () => {
    deploy();
    await Promise.all([assertProgram(), assertProgram(), assertProgram()].map((p) => p.catch(() => undefined)));
    expect(h.reads).toBeLessThanOrEqual(1);
  });
});

describe("a tab", () => {
  const answer = (build: string) => (async () => new Response(JSON.stringify({ build }))) as unknown as typeof fetch;
  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

  it("whose build is older than the server's is told to reload, before anything else", async () => {
    deploy();
    await expect(requireCurrentApp({ fetch: answer("431000999:newer"), conn })).rejects.toMatchObject({ code: "StaleApp", message: /^StaleApp: .*Reload/ });
  });

  it("on the build the server runs, still checks the chain itself (unpinned: nothing is signed)", async () => {
    deploy();
    await expect(requireCurrentApp({ fetch: answer(APP_BUILD), conn })).rejects.toMatchObject({ code: "ProgramMismatch" });
    await expect(requireCurrentApp({ fetch: down, conn })).rejects.toMatchObject({ code: "ProgramMismatch" });
  });

  it("on the server's build, with the pinned program deployed, writes; also when the server can't be reached", async () => {
    deploy();
    const pin = await pinned();
    await expect(requireCurrentApp({ fetch: answer(APP_BUILD), conn, pin })).resolves.toBeUndefined();
    forgetWriteGuard();
    await expect(requireCurrentApp({ fetch: down, conn, pin })).resolves.toBeUndefined();
    forgetWriteGuard();
    deploy(SLOT + 7); // upgraded since: this tab's program is gone
    await expect(requireCurrentApp({ fetch: down, conn, pin })).rejects.toMatchObject({ code: "ProgramMismatch" });
  });

  it("chain.ts asks before it signs anything, on every write path", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/lib/service/chain.ts"), "utf8");
    const pay = source.slice(source.indexOf("async function pay("));
    expect(pay.slice(0, pay.indexOf("runPayment("))).toMatch(/await requireCurrentApp\(\);/);
    // Every program write and every USD₮ payment goes through pay().
    expect(source.match(/runPayment\(/g)).toHaveLength(1);
  });
});
