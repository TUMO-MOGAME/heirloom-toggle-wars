import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { activityParts, activityText, nameBook, nameOf } from "./people";
import { describeEvent } from "./chain/events";
import { activityFrom } from "./chain/reads";
import { publicSnapshot } from "./audit";
import { formatUsdt, shortAddress } from "./format";
import type { EstateSnapshot } from "./service/types";
import type { ActivityItem } from "./types";

// Real-looking wallets (the demo personas' addresses); nothing here is on-chain.
const OWNER = "YdzZuEsaYP4FJhVaNzT9UbiUqWG24D7dP14isb7U368";
const LERATO = "6ckEzZLHJ4XLXLP7jrkjFau22cK8KhV2cVeWyhqJmSWm";
const NDLOVU = "3Shi7YitQt1uDDnmfGbL9EEkespgos2QpCDaph5Go2at";
const PILLAY = "GpufgMWp8sgFEYgaJ1XoEu42JG7pKVBD4kfaDbohp8rM";
const BONGANI = "ALpw94XmFYogivyVbrHq1NGuvY5fqxryyqkxmbiiRtHm";
const PIETER = "BMajP1ye9ZJg18xBQ6GX9fL8cTzFJQ9roQuqQdSZMrq1";
const ZODWA = "CGXzXMjCLuc3eCpNPH6LgH9KQtqpJdskeDzG9ENubbm5";
const KAGISO = "2sAMPfndNtAWWqsRmMbBkYRxBBgQGZLnUTVmGwYcBrwu";
const UNI = "6veGKXYUDGqBDjrP4137igAiMWpRHiwiGCUH8ssjKU8z";
const AGENT = "HLbTqB1gmrnFBxKhZ4dhqvVsoMxMXDhF2p4rGBxT7AN1";
const STRANGER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function snapshot(over: Partial<EstateSnapshot> = {}): EstateSnapshot {
  return {
    estate: {
      address: "2LXvcYbqbtZND3qrfKPex9N7Red3kvPAGDReXWdxymP7", owner: OWNER, ownerName: "Thabo Mokoena", agent: AGENT,
      verifiers: [NDLOVU, PILLAY, BONGANI], verifierNames: ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"],
    } as EstateSnapshot["estate"],
    beneficiaries: [{ address: "pda1", wallet: LERATO, label: "Lerato (daughter)", active: true }],
    payees: [{ address: "pda2", wallet: UNI, kind: "University", name: "University of Cape Town" }],
    rules: [], claims: [], assets: [], offers: [], hardships: [], activity: [],
    ...over,
  };
}

const line = (text: string, parties?: string[]): ActivityItem => ({ ts: 1, kind: "X", text, ...(parties ? { parties } : {}) });

describe("nameBook", () => {
  it("names the estate's roles by wallet", () => {
    const book = nameBook(snapshot(), { agentLabel: "Heirloom agent" });
    expect(book.get(OWNER)?.name).toBe("Thabo Mokoena");
    expect(book.get(NDLOVU)?.name).toBe("Adv. Thandi Ndlovu");
    expect(book.get(LERATO)?.name).toBe("Lerato"); // "(daughter)" dropped
    expect(book.get(UNI)?.name).toBe("University of Cape Town");
    expect(book.get(AGENT)?.name).toBe("Heirloom agent"); // also the fee sponsor's wallet
    expect(book.has(STRANGER)).toBe(false);
  });

  it("adds guardians, buyers, the service's off-chain names and this device's wallets", () => {
    const snap = snapshot({
      offers: [{ address: "o1", asset: "a1", buyer: PIETER, buyerName: "Pieter van Wyk", amount: 1n, createdAt: 0 }],
      guardians: {
        enabled: true, objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120, feed: [], objections: [],
        seats: [{ index: 2, holder: BONGANI, holderName: "Uncle Bongani Mokoena", backups: [{ wallet: KAGISO, name: "Cousin Kagiso Mokoena" }], monitors: [{ wallet: ZODWA, name: "Aunt Zodwa Mokoena" }] }],
        fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
      } as unknown as EstateSnapshot["guardians"],
      names: { [STRANGER]: "Priya Naidoo" },
    });
    const book = nameBook(snap, { wallets: [{ address: "Mine1111111111111111111111111111111111111111", label: "My savings" }, { address: OWNER, label: "Dad's phone" }] });
    expect(book.get(PIETER)?.name).toBe("Pieter van Wyk");
    expect(book.get(KAGISO)?.name).toBe("Cousin Kagiso Mokoena");
    expect(book.get(ZODWA)?.name).toBe("Aunt Zodwa Mokoena");
    expect(book.get(STRANGER)?.name).toBe("Priya Naidoo");
    expect(book.get("Mine1111111111111111111111111111111111111111")?.name).toBe("My savings");
    expect(book.get(OWNER)?.name).toBe("Thabo Mokoena"); // the estate's name wins over a device label
  });

  it("ignores empty names, 'Someone' and names that are only the address again", () => {
    const snap = snapshot({ names: { [STRANGER]: shortAddress(STRANGER), [PIETER]: "  ", [ZODWA]: "Someone" } });
    const book = nameBook(snap);
    expect(book.has(STRANGER)).toBe(false);
    expect(book.has(PIETER)).toBe(false);
    expect(book.has(ZODWA)).toBe(false);
    expect(nameBook(null, { wallets: [{ address: PIETER, label: "Pieter" }] }).get(PIETER)?.name).toBe("Pieter");
  });

  it("gives the short form used in sentences", () => {
    const book = nameBook(snapshot());
    expect(nameOf(book, NDLOVU)).toBe("Adv. Ndlovu");
    expect(nameOf(book, BONGANI)).toBe("Uncle Bongani");
    expect(nameOf(book, UNI)).toBe("University of Cape Town"); // institutions keep their full name
    expect(nameOf(nameBook(snapshot(), { agentLabel: "Heirloom agent" }), AGENT)).toBe("Heirloom agent");
    expect(nameOf(book, STRANGER)).toBeNull();
    expect(nameOf(book, null)).toBeNull();
  });
});

describe("activityParts", () => {
  const book = nameBook(snapshot());

  it("swaps each named wallet's short address for the person's name and keeps the full address", () => {
    const item = line(`Verifier ${shortAddress(NDLOVU)} attested the death`, [NDLOVU]);
    expect(activityText(item, book)).toBe("Verifier Adv. Ndlovu attested the death");
    expect(activityParts(item, book)).toEqual([
      { text: "Verifier " },
      { text: "Adv. Ndlovu", address: NDLOVU, named: true, full: "Adv. Thandi Ndlovu" },
      { text: " attested the death" },
    ]);
  });

  it("keeps the short address for a wallet nobody knows, still marked as a wallet", () => {
    const item = line(`Offer withdrawn by ${shortAddress(STRANGER)}`, [STRANGER]);
    expect(activityText(item, book)).toBe(`Offer withdrawn by ${shortAddress(STRANGER)}`);
    expect(activityParts(item, book)[1]).toEqual({ text: shortAddress(STRANGER), address: STRANGER, named: false });
  });

  it("handles two wallets in one line", () => {
    const item = line(`${shortAddress(KAGISO)} now holds the seat of ${shortAddress(BONGANI)}`, [KAGISO, BONGANI]);
    const withKagiso = nameBook(snapshot({ names: { [KAGISO]: "Cousin Kagiso Mokoena" } }));
    expect(activityText(item, withKagiso)).toBe("Cousin Kagiso now holds the seat of Uncle Bongani");
  });

  it("leaves demo lines (names already in the text, no parties) as they are", () => {
    const item = line("Adv. Ndlovu confirmed the passing (1 of 2)");
    expect(activityParts(item, book)).toEqual([{ text: "Adv. Ndlovu confirmed the passing (1 of 2)" }]);
  });
});

describe("chain events carry the wallets they name", () => {
  it("lists the wallets whose short address the line shows", () => {
    const d = describeEvent("DeathAttested", { estate: new PublicKey(OWNER), verifier: new PublicKey(NDLOVU) });
    expect(d.text).toBe(`Verifier ${shortAddress(NDLOVU)} attested the death`);
    expect(d.parties).toEqual([NDLOVU]); // the estate key is not in the text, so not a party
  });

  it("leaves parties out of lines that name nobody", () => {
    expect(describeEvent("EstateUnlocked", { estate: new PublicKey(OWNER) }).parties).toBeUndefined();
  });

  it("puts names on a devnet feed through the same path", () => {
    const [item] = activityFrom([{ name: "ClaimPaid", data: { payee: new PublicKey(UNI), amount: "350000000" }, ts: 5, signature: "sig" }]);
    expect(item.parties).toEqual([UNI]);
    expect(activityText(item, nameBook(snapshot()))).toBe(`${formatUsdt(350_000_000n)} paid to University of Cape Town`);
  });
});

describe("public record", () => {
  it("drops the service's extra names", () => {
    const snap = snapshot({ names: { [STRANGER]: "Priya" } });
    snap.estate = { ...snap.estate, death: {} as EstateSnapshot["estate"]["death"] };
    expect(publicSnapshot(snap).names).toBeUndefined();
  });
});
