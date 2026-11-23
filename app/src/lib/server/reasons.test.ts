/**
 * Plan §18.9 M9: dispute and objection reasons lived only on the writer's device in chain mode. /api/reasons keeps them:
 * written only by the person who raised the challenge, only when the text's hash is the one on-chain, read by members.
 * Real ed25519 signatures through the real route; the chain is a fake reader.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));

const { getIdl } = await import("../chain/idl");
const { objectionPda } = await import("../chain/pda");
const { actionHeaders } = await import("../access/client");
const { actionBody } = await import("../access/messages");
const { reasonHash, reasonsRoutes, resetReasonsMemory } = await import("./reasons");
import type { Raw } from "../chain/decoders";

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
  return { address, signMessage: async (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex") };
}
const programId = new PublicKey(getIdl().address);
const estate = Keypair.generate().publicKey.toBase58();
const claim = Keypair.generate().publicKey.toBase58();
const REASON = "Thandi was not enrolled this term; the fee statement is old.";
let raiser: ReturnType<typeof wallet>, other: ReturnType<typeof wallet>;
let objections: Record<string, Raw>;
let ip = 0;

const routes = () => reasonsRoutes({
  member: async (req) => (req.headers.get("x-test-member") === "yes" ? "member" : null),
  fetchRaw: async (_t, address) => objections[address] ?? null,
  chain: () => true, now: () => Date.now(),
});
const raise = (by: string, text = REASON, target = claim) => {
  objections[objectionPda(programId, target).toBase58()] = {
    estate, target, monitor: by, reason_hash: Array.from(Buffer.from(reasonHash(text), "hex")),
  } as unknown as Raw;
};
async function save(who: ReturnType<typeof wallet>, reason = REASON, signedHash = reasonHash(reason), target = claim) {
  const headers = { ...(await actionHeaders(who, "reason", estate, actionBody.reason({ target, hash: signedHash }))), "x-forwarded-for": `10.9.0.${++ip}` };
  const res = await routes().POST(new Request("http://t/api/reasons", { method: "POST", headers, body: JSON.stringify({ estate, target, reason }) }));
  return { status: res.status, body: (await res.json()) as { code?: string; durable?: boolean } };
}
const read = async (member: boolean) => {
  const res = await routes().GET(new Request(`http://t/api/reasons?estate=${estate}`, { headers: { "x-test-member": member ? "yes" : "no" } }));
  return { status: res.status, body: (await res.json()) as { reasons?: { target: string; hash: string; reason: string }[] } };
};

beforeEach(() => {
  resetReasonsMemory();
  [raiser, other] = [wallet(), wallet()];
  objections = {};
});

describe("/api/reasons", () => {
  it("the person who raised it saves the words, and the family reads them by target and hash", async () => {
    raise(raiser.address);
    expect(await save(raiser)).toEqual({ status: 200, body: { ok: true, durable: false } });
    expect((await read(true)).body.reasons).toEqual([{ target: claim, hash: reasonHash(REASON), reason: REASON }]);
  });

  it("outsiders read nothing", async () => {
    raise(raiser.address);
    await save(raiser);
    expect((await read(false)).status).toBe(403);
  });

  it("nobody else can put words in the raiser's mouth", async () => {
    raise(raiser.address);
    expect((await save(other)).body.code).toBe("forbidden");
  });

  it("the words must be the ones whose hash is on-chain", async () => {
    raise(raiser.address);
    expect((await save(raiser, "Something else entirely")).body.code).toBe("hash_mismatch");
  });

  it("a signature over another text's hash is refused", async () => {
    raise(raiser.address);
    expect((await save(raiser, REASON, reasonHash("other"))).status).toBe(401);
  });

  it("a challenge that isn't on-chain gets no reason", async () => {
    expect((await save(raiser)).status).toBe(404);
  });
});
