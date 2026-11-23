/** Who gets an estate in their list: found by byte offsets, so checked on accounts the IDL's own coder wrote. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";

const h = vi.hoisted(() => ({ calls: 0, fail: false, accounts: [] as { pubkey: unknown; account: { data: Uint8Array } }[] }));
vi.mock("./tx", async (original: () => Promise<object>) => ({
  ...(await original()),
  getConnection: () => ({
    getProgramAccounts: async () => {
      h.calls++;
      if (h.fail) throw new Error("429");
      return h.accounts;
    },
  }),
}));

const { accountDiscriminator, getCoder } = await import("./idl");
const { invalidateProgramAccounts } = await import("./reads");
const { estateRolesOf } = await import("./estate-roles");

const k = () => Keypair.generate().publicKey;
const none = PublicKey.default;
let me: PublicKey, estate: PublicKey;

const add = (data: Uint8Array, pubkey = k()) => void h.accounts.push({ pubkey, account: { data } });
const seat = async (over: { backups?: PublicKey[]; monitors?: PublicKey[]; vacant?: boolean }, of = estate) =>
  add(await getCoder().accounts.encode("Seat", {
    estate: of, index: 1, holder: k(), backups: [none, none], monitors: [none, none], generation: 0, vacant: false,
    death_cert_hash: Array(32).fill(0), death_reported_by: none, death_verdict: { Pending: {} },
    death_confirmed_by: none, death_pending_since: new BN(0), bump: 1, ...over,
  }));
const guard = async (fallback: PublicKey[], fallbackDead = 0) =>
  add(await getCoder().accounts.encode("Guard", {
    estate, objection_window_secs: new BN(60), succession_wait_secs: new BN(60), fallback_wait_secs: new BN(60),
    open_objections: 0, fallback, fallback_dead: fallbackDead, fallback_started_at: new BN(0), fallback_done: false, bump: 1,
  }));
const beneficiary = async (active: boolean) =>
  add(await getCoder().accounts.encode("Beneficiary", { estate, wallet: me, label: "Lerato", active, bump: 1 }));
/** Estate.verifiers[1]. */
const trusted = () => {
  const data = new Uint8Array(400);
  data.set(accountDiscriminator("Estate"));
  data.set(me.toBytes(), 136);
  add(data, estate);
};
const roles = async () => (await estateRolesOf(me.toBase58())).map((r) => [r.estate, r.role]);
/** `me` in place `i` of a list of `length`, strangers in the others. */
const meAt = (i: number, length: number) => Array.from({ length }, (_, j) => (j === i ? me : k()));

beforeEach(() => {
  [me, estate] = [k(), k()];
  Object.assign(h, { calls: 0, fail: false, accounts: [] });
  invalidateProgramAccounts();
});

describe("estateRolesOf", () => {
  it.each([0, 1])("backup %i only: the estate, as monitor", async (i) => {
    await seat({ backups: meAt(i, 2) });
    expect(await roles()).toEqual([[estate.toBase58(), "monitor"]]);
  });

  it.each([0, 1])("monitor %i only: the estate, as monitor", async (i) => {
    await seat({ monitors: meAt(i, 2) });
    expect(await roles()).toEqual([[estate.toBase58(), "monitor"]]);
  });

  it.each([0, 1, 2, 3])("fallback recipient %i only: the estate, as monitor", async (i) => {
    await guard(meAt(i, 4));
    expect(await roles()).toEqual([[estate.toBase58(), "monitor"]]);
  });

  it("a fallback recipient reported dead still gets it: that is who says they are alive (R4)", async () => {
    await guard([me, none, none, none], 1);
    expect(await roles()).toEqual([[estate.toBase58(), "monitor"]]);
  });

  it("a monitor of a vacant seat still gets it", async () => {
    await seat({ monitors: [me, none], vacant: true });
    expect(await roles()).toEqual([[estate.toBase58(), "monitor"]]);
  });

  it("a removed beneficiary gets nothing", async () => {
    await beneficiary(false);
    expect(await roles()).toEqual([]);
  });

  it("a removed beneficiary who is still a fallback recipient gets it for that alone", async () => {
    await beneficiary(false);
    await guard([me, none, none, none]);
    expect(await roles()).toEqual([[estate.toBase58(), "monitor"]]);
  });

  it("an active beneficiary keeps that role", async () => {
    await beneficiary(true);
    await guard([me, none, none, none]);
    expect(await roles()).toEqual([[estate.toBase58(), "beneficiary"]]);
  });

  it("a trusted person keeps that role", async () => {
    trusted();
    await seat({ backups: [me, none] });
    expect(await roles()).toEqual([[estate.toBase58(), "verifier"]]);
  });

  it("several parts in one estate list it once; another estate is listed too", async () => {
    const other = k();
    await seat({ backups: [me, none], monitors: [me, none] });
    await seat({ monitors: [none, me] });
    await guard([none, me, none, none]);
    await seat({ backups: [none, me] }, other);
    expect((await roles()).sort()).toEqual([[estate.toBase58(), "monitor"], [other.toBase58(), "monitor"]].sort());
  });

  it("a stranger gets nothing, also where the key stands in a field that is no role", async () => {
    await seat({ backups: meAt(-1, 2), monitors: meAt(-1, 2) }, me);
    await guard(meAt(-1, 4));
    expect(await roles()).toEqual([]);
  });

  it("costs one getProgramAccounts call", async () => {
    await seat({ backups: [me, none] });
    await roles();
    expect(h.calls).toBe(1);
  });

  it("costs one call also when the RPC refuses it", async () => {
    h.fail = true;
    expect(await roles()).toEqual([]);
    expect(h.calls).toBe(1);
  });
});
