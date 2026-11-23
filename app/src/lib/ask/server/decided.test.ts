/** Plan §18.9 (low): once a request is decided, the asker can't rewrite what it was for. Real signatures. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import bs58 from "bs58";
import type { Raw } from "@/lib/chain/decoders";

vi.mock("server-only", () => ({}));
const { askRoutes } = await import("./route");
const { getAsk, resetAskMemory, saveAsk } = await import("./store");
const { askMessage, noteBody } = await import("../auth-message");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const asker = bs58.encode(Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"));
const estate = bs58.encode(Buffer.alloc(32, 3)), claim = bs58.encode(Buffer.alloc(32, 4));
let claimRaw: Raw;
let ts = Date.now();

const routes = () => askRoutes({ fetchRaw: async (type) => (type === "Claim" ? claimRaw : null), now: () => Date.now(), chain: () => true, member: async () => "m" });
async function note(purpose: string) {
  const n = { purpose, currency: "USDT", typed: 5, attachment: false };
  const at = ++ts;
  const sig = edSign(null, Buffer.from(askMessage("note", estate, claim, asker, at, sha(noteBody(n))), "utf8"), privateKey).toString("hex");
  const res = await routes().POST(new Request("http://t/api/asks", {
    method: "POST", headers: { "x-forwarded-for": `10.7.0.${at % 200}` }, body: JSON.stringify({ action: "note", estate, claim, wallet: asker, ts: at, sig, ...n }),
  }));
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
}
const claimWith = (over: Record<string, unknown> = {}) => {
  claimRaw = { estate, beneficiary: asker, created_at: 1, status: { Open: {} }, owner_approved: false, approvals: 0, ...over } as unknown as Raw;
};

beforeEach(() => { resetAskMemory(); claimWith(); });

describe("what a request is for", () => {
  it("can be said while nobody has decided", async () => {
    expect((await note("School trip")).status).toBe(200);
    expect((await note("School trip to the museum")).status).toBe(200);
  });

  it.each([
    ["approved by the owner", { owner_approved: true }],
    ["approved by a trusted person", { approvals: 1 }],
    ["paid", { status: { Paid: {} } }],
  ])("can't be rewritten once %s", async (_why, over) => {
    await note("School trip");
    claimWith(over);
    expect(await note("A new phone")).toEqual({ status: 409, code: "decided" });
    expect((await getAsk(claim))?.purpose).toBe("School trip");
  });

  it("nor after the owner said no", async () => {
    await saveAsk({ estate, claim, purpose: "School trip", currency: "USDT", typed: 5, attachment: false, createdAt: 1, declinedAt: 9 });
    expect((await note("Something the owner would have agreed to")).code).toBe("decided");
  });

  it("is still saved for a request the agent turned down, if it had none yet", async () => {
    claimWith({ status: { Rejected: {} } });
    expect((await note("School trip")).status).toBe(200);
  });
});
