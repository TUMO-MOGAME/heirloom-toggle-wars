/** The guardians service after the second review: the optional accounts each signer passes, reports, seats' monitors. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { findInstruction, getCoder, getIdl } from "../chain/idl";
import { beneficiaryPda, estatePda, fallbackReportPda, guardPda, seatPda } from "../chain/pda";
import type { Raw } from "../chain/decoders";
import { sha256Hex } from "../agent/hash";

const h = vi.hoisted(() => ({ me: "", accounts: new Map<string, unknown>(), family: [] as unknown[], seats: [] as unknown[] }));
const programId = new PublicKey(getIdl().address);
const usdtMint = Keypair.generate().publicKey;
vi.mock("../chain/client", () => ({ chainCtx: () => ({ programId, usdtMint }) }));
vi.mock("../wallet/signer", () => ({ getActiveSigner: () => ({ address: h.me }) }));
vi.mock("../chain/reads", async (original: () => Promise<object>) => ({
  ...(await original()),
  fetchAccountRaw: async (_type: string, address: string) => h.accounts.get(address) ?? null,
  scanAccounts: async () => h.family,
  decodeScanned: (_type: string, a: unknown) => a,
}));
vi.mock("../chain/guardians", async (original: () => Promise<object>) => ({
  ...(await original()),
  fetchGuardiansRaw: async () => ({ guard: null, seats: h.seats, objections: [], stamps: {}, media: {} }),
}));
const { createChainGuardians, defaultMonitor } = await import("./chain-guardians");

const key = () => Keypair.generate().publicKey.toBase58();
const NOBODY = PublicKey.default.toBase58();
const [owner, v0, v1, v2, kid, kid2, monitor, stranger, recipient, rentPayer, confirmer] = Array.from({ length: 11 }, key);
const estate = estatePda(programId, owner).toBase58();
const none = programId.toBase58();
const ben = (w: string) => beneficiaryPda(programId, estate, w).toBase58();
const seatAt = (i: number) => seatPda(programId, estate, i).toBase58();
const reportAt = (i: number) => fallbackReportPda(programId, estate, i).toBase58();
const zero = Array<number>(32).fill(0);
const file = () => new File(["%PDF-1.4 certificate"], "c.pdf", { type: "application/pdf" });

let sent: TransactionInstruction[];
let reviewed: number[];

function setSeat(i: number, over: Record<string, unknown> = {}) {
  h.accounts.set(seatAt(i), {
    index: i, holder: [v0, v1, v2][i], backups: [NOBODY, NOBODY], monitors: [NOBODY, NOBODY], death_cert_hash: zero,
    death_verdict: { Pending: {} }, death_reported_by: NOBODY, death_confirmed_by: NOBODY, death_pending_since: 0, ...over,
  });
}
const setEstate = (over: Record<string, unknown> = {}) => h.accounts.set(estate, {
  owner, verifiers: [v0, v1, v2], status: { Active: {} }, waiting_period_secs: 120, ...over,
});
const setReport = (slot: number, over: Record<string, unknown> = {}) => h.accounts.set(reportAt(slot), {
  recipient, reporter: kid2, rent_payer: rentPayer, cert_hash: Array<number>(32).fill(4), verdict: { Approved: {} }, reported_at: 1_000, ...over,
});

beforeEach(() => {
  h.accounts.clear();
  h.me = v0;
  h.family = [
    { wallet: kid2, label: "Family member 2", active: true }, { wallet: kid, label: "Family member 1", active: true },
    { wallet: stranger, label: "Family member 3", active: false },
  ];
  h.seats = [{ address: seatAt(1), raw: { index: 1, monitors: [monitor, NOBODY] } as Raw }];
  sent = [];
  reviewed = [];
  setEstate();
  for (const i of [0, 1, 2]) setSeat(i);
  for (const w of [kid, kid2]) h.accounts.set(ben(w), { active: true });
  h.accounts.set(ben(stranger), { active: false });
  // A gap: the second recipient on screen is in slot 2.
  h.accounts.set(guardPda(programId, estate).toBase58(), { fallback: [kid, NOBODY, recipient, NOBODY], fallback_dead: 0, fallback_wait_secs: 120 });
});

const deps = (): Parameters<typeof createChainGuardians>[0] => ({
  send: async (ixs) => {
    sent.push(...(typeof ixs === "function" ? ixs(new PublicKey(h.me)) : ixs));
    return { signature: "sent", explorerUrl: "" };
  },
  review: async (_f, _p, _e, _c, index) => {
    reviewed.push(index);
    return { report: { summary: "ok" } as never, tx: { signature: "review", explorerUrl: "" } };
  },
  getMeta: async () => null,
  saveMeta: async () => undefined,
  requireOwnerOf: () => {
    if (h.me !== owner) throw new Error("NotOwner: switch to the owner's wallet.");
    return new PublicKey(owner);
  },
  getEstate: async () => ({}),
});
const svc = () => createChainGuardians(deps());

const account = (name: string, t = sent[0]) => {
  const decoded = getCoder().instruction.decode(Buffer.from(t.data))!.name;
  return t.keys[findInstruction(decoded).accounts.findIndex((a) => a.name === name)].pubkey.toBase58();
};
const args = (t = sent[0]) => getCoder().instruction.decode(Buffer.from(t.data))!.data as Record<string, unknown>;

describe("reportSeatDeath", () => {
  it.each([
    ["a trusted person", () => v0, () => none], ["the owner", () => owner, () => none],
    ["the seat's monitor", () => monitor, () => none], ["a beneficiary", () => kid, () => ben(kid)],
  ])("%s passes the right optional account", async (_, who, expected) => {
    h.me = who();
    setSeat(1, { monitors: [monitor, NOBODY] });
    await svc().reportSeatDeath(estate, 1, file());
    expect(account("beneficiary_account")).toBe(expected());
  });

  it("your own unreviewed report of the same file: only the review again", async () => {
    const hash = await sha256Hex(new Uint8Array(await file().arrayBuffer()));
    setSeat(1, { death_cert_hash: [...Buffer.from(hash, "hex")], death_reported_by: v0, death_pending_since: Math.floor(Date.now() / 1000) });
    expect((await svc().reportSeatDeath(estate, 1, file())).tx?.signature).toBe("review");
    expect(sent).toEqual([]);
  });

  it("a resumed report whose review signed nothing (an unnamed person) answers tx: null", async () => {
    const hash = await sha256Hex(new Uint8Array(await file().arrayBuffer()));
    setSeat(1, { death_cert_hash: [...Buffer.from(hash, "hex")], death_reported_by: v0, death_pending_since: Math.floor(Date.now() / 1000) });
    const quiet = createChainGuardians({ ...deps(), review: async () => ({ report: { summary: "no name" } as never, tx: null }) });
    expect((await quiet.reportSeatDeath(estate, 1, file())).tx).toBeNull();
  });

  it("someone else's fresh report can't be replaced yet", async () => {
    setSeat(1, { death_cert_hash: Array<number>(32).fill(7), death_reported_by: kid, death_pending_since: Math.floor(Date.now() / 1000) });
    await expect(svc().reportSeatDeath(estate, 1, file())).rejects.toMatchObject({ code: "SuccessionPending" });
    expect([sent, reviewed]).toEqual([[], []]);
  });

  it("a stale one is replaced", async () => {
    setSeat(1, { death_cert_hash: Array<number>(32).fill(7), death_reported_by: kid, death_pending_since: 1 });
    await svc().reportSeatDeath(estate, 1, file());
    expect(sent).toHaveLength(1);
  });
});

describe("confirmSeatDeath (R18)", () => {
  const lastHolder = () => setEstate({ verifiers: [NOBODY, NOBODY, v2] });

  it("the last holder nobody watches: an active beneficiary passes their account", async () => {
    lastHolder();
    h.me = kid;
    await svc().confirmSeatDeath(estate, 2);
    expect(account("beneficiary_account")).toBe(ben(kid));
  });

  const recent = () => ({ death_pending_since: Math.floor(Date.now() / 1000) });

  it.each([
    ["a monitor exists", { monitors: [monitor, NOBODY] }], ["a second backup exists", { backups: [key(), key()] }],
  ])("not when %s, until the report has waited the recovery timeout", async (_, over) => {
    lastHolder();
    setSeat(2, { ...over, ...recent() });
    h.me = kid;
    await svc().confirmSeatDeath(estate, 2);
    expect(account("beneficiary_account")).toBe(none);
    setSeat(2, { ...over, death_pending_since: Math.floor(Date.now() / 1000) - 4 * 120 });
    await svc().confirmSeatDeath(estate, 2);
    expect(account("beneficiary_account", sent[1])).toBe(ben(kid));
  });

  it("a monitor who is also the first backup doesn't watch the seat", async () => {
    lastHolder();
    const first = key();
    setSeat(2, { monitors: [first, NOBODY], backups: [first, NOBODY], ...recent() });
    h.me = kid;
    await svc().confirmSeatDeath(estate, 2);
    expect(account("beneficiary_account")).toBe(ben(kid));
  });

  it("not while another seat is held (before the timeout), nor for a removed beneficiary, nor for a holder", async () => {
    setSeat(2, recent());
    h.me = kid;
    await svc().confirmSeatDeath(estate, 2);
    lastHolder();
    h.me = stranger;
    await svc().confirmSeatDeath(estate, 2);
    setSeat(2, { death_pending_since: 0 });
    h.me = v2;
    await svc().confirmSeatDeath(estate, 2);
    expect(sent.map((t) => account("beneficiary_account", t))).toEqual([none, none, none]);
  });
});

describe("finalizeSuccession", () => {
  it.each([["a confirmed report", () => confirmer], ["no confirmation", () => NOBODY]])(
    "%s: exactly the IDL's accounts, no remaining account (the program reads none)", async (_, by) => {
      setSeat(2, { death_confirmed_by: by() });
      await svc().finalizeSuccession(estate, 2);
      expect(sent[0].keys).toHaveLength(findInstruction("finalize_succession").accounts.length);
      expect(sent[0].keys.some((k) => k.pubkey.equals(beneficiaryPda(programId, estate, by())))).toBe(false);
    },
  );
});

describe("a fallback death", () => {
  it.each([
    ["a trusted person", () => v1, () => none, () => none], ["a monitor", () => monitor, () => seatAt(1), () => none],
    ["a beneficiary", () => kid2, () => none, () => ben(kid2)], ["a listed recipient", () => kid, () => none, () => ben(kid)],
  ])("%s reports, on the recipient's slot", async (_, who, seat, beneficiary) => {
    h.me = who();
    await svc().reportFallbackDeath(estate, 1, file());
    expect([args().index, account("signer_seat"), account("beneficiary_account"), account("fallback_report")])
      .toEqual([2, seat(), beneficiary(), reportAt(2)]);
    expect(reviewed).toEqual([2]);
  });

  it("a listed recipient who is nothing else passes neither account", async () => {
    h.me = recipient;
    await svc().reportFallbackDeath(estate, 0, file());
    expect([account("signer_seat"), account("beneficiary_account")]).toEqual([none, none]);
  });

  it("an outsider and the recipient themselves can't", async () => {
    h.me = stranger;
    await expect(svc().reportFallbackDeath(estate, 1, file())).rejects.toMatchObject({ code: "NotParticipant" });
    h.me = recipient;
    await expect(svc().reportFallbackDeath(estate, 1, file())).rejects.toMatchObject({ code: "NotParticipant" });
    expect(sent).toEqual([]);
  });

  it("a fresh report by someone else stands", async () => {
    setReport(2, { reported_at: Math.floor(Date.now() / 1000) });
    await expect(svc().reportFallbackDeath(estate, 1, file())).rejects.toMatchObject({ code: "BadStatus" });
  });

  it("\"I'm alive\": the recipient refutes, rent back to who paid", async () => {
    setReport(2, { verdict: { Pending: {} } });
    h.me = recipient;
    await svc().resolveFallbackDeath(estate, 1, false);
    expect(args()).toMatchObject({ index: 2, dead: false });
    expect([account("rent_to"), account("signer_seat"), account("beneficiary_account")]).toEqual([rentPayer, none, none]);
  });

  it("only they can", async () => {
    setReport(2);
    await expect(svc().resolveFallbackDeath(estate, 1, false)).rejects.toMatchObject({ code: "NotParticipant" });
  });

  it.each([
    ["a trusted person", () => v0, () => none, () => none], ["a monitor", () => monitor, () => seatAt(1), () => none],
    ["a beneficiary", () => kid, () => none, () => ben(kid)],
  ])("%s confirms after the wait", async (_, who, seat, beneficiary) => {
    setReport(2);
    h.me = who();
    await svc().resolveFallbackDeath(estate, 1, true);
    expect([args().dead, account("signer_seat"), account("beneficiary_account"), account("rent_to")]).toEqual([true, seat(), beneficiary(), rentPayer]);
  });

  it.each([
    ["before the wait", { reported_at: 9_999_999_999 }, "WaitingPeriodNotOver", () => v0],
    ["unreviewed", { verdict: { Pending: {} } }, "AgentNotApproved", () => v0],
    ["by the reporter", {}, "NotConfirmer", () => kid2],
    ["by the recipient", {}, "NotConfirmer", () => recipient],
  ])("no confirmation %s", async (_, over, code, who) => {
    setReport(2, over);
    h.me = who();
    await expect(svc().resolveFallbackDeath(estate, 1, true)).rejects.toMatchObject({ code });
    expect(sent).toEqual([]);
  });

  it("no report, nothing to resolve", async () => {
    await expect(svc().resolveFallbackDeath(estate, 1, true)).rejects.toMatchObject({ code: "BadStatus" });
  });

  it("executeFallback passes the next recipient's slot report", async () => {
    h.accounts.set(guardPda(programId, estate).toBase58(), { fallback: [kid, NOBODY, recipient, NOBODY], fallback_dead: 1 });
    await svc().executeFallback(estate);
    expect([account("recipient"), account("fallback_report")]).toEqual([recipient, reportAt(2)]);
  });
});

describe("voteObjection", () => {
  const vote = async (kind: string, target: string) => {
    const objection = key();
    h.accounts.set(objection, { kind: { [kind]: {} }, target });
    h.me = monitor;
    await svc().voteObjection(estate, objection, false);
  };

  it("a fallback vote passes the three seats", async () => {
    await vote("Fallback", guardPda(programId, estate).toBase58());
    expect(sent[0].keys.slice(-3).map((m) => m.pubkey.toBase58())).toEqual([0, 1, 2].map(seatAt));
  });

  it("a dismissal passes the target too", async () => {
    const claim = key();
    await vote("Claim", claim);
    expect(account("target_account")).toBe(claim);
  });
});

describe("setupGuardians gives each new seat a monitor (§18.8)", () => {
  const setup = async (monitors: string[] = []) => {
    h.me = owner;
    for (const i of [0, 1, 2]) h.accounts.delete(seatAt(i));
    await svc().setupGuardians(estate, {
      seats: [0, 1, 2].map((index) => ({ index, backups: [], monitors: monitors.map((wallet) => ({ wallet, name: "" })) })), fallback: [],
    });
    return sent.map((t) => (args(t).monitors as PublicKey[]).map(String));
  };

  it("from the active family, spread over the seats", async () => {
    expect(await setup()).toEqual([[kid, NOBODY], [kid2, NOBODY], [kid, NOBODY]]);
  });

  it("the owner's own choice stands", async () => {
    expect(await setup([monitor])).toEqual([[monitor, NOBODY], [monitor, NOBODY], [monitor, NOBODY]]);
  });

  it("never the holder, the owner or the backup who would take the seat; rather not a trusted person", () => {
    const pick = (family: string[], backups: string[] = []) => defaultMonitor(0, { holder: v0, backups, family, verifiers: [v0, v1, v2], owner });
    expect(pick([v0, owner])).toBeNull();
    expect(pick([kid, kid2], [kid])).toBe(kid2);
    expect(pick([v1, kid])).toBe(kid);
    expect(pick([v1])).toBe(v1);
  });
});

describe("setAssetMedia (R22)", () => {
  const save = () => svc().setAssetMedia(estate, key(), { kind: "Car", title: "Car", photos: [] });

  it("the owner, while Active", async () => {
    h.me = owner;
    await save();
    expect(account("authority")).toBe(owner);
  });

  it("nobody else, nobody after the unlock", async () => {
    await expect(save()).rejects.toThrow(/^NotOwner/);
    h.me = owner;
    setEstate({ status: { Unlocked: {} } });
    await expect(save()).rejects.toMatchObject({ code: "BadStatus" });
    expect(sent).toEqual([]);
  });
});
