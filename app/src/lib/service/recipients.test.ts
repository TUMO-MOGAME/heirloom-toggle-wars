/** /send lists the estate's people by name on the live network too (bug 18). */
import { describe, expect, it } from "vitest";
import { estateRecipients, mergeRecipients } from "./recipients";

const snap = {
  estate: { owner: "OWNER", ownerName: "Thabo Mokoena", verifiers: ["V1", "V2", "V3"], verifierNames: ["Adv. Thandi Ndlovu", "Ms. Anita Pillay", "Uncle Bongani Mokoena"] },
  beneficiaries: [
    { address: "b1", wallet: "LERATO", label: "Lerato (daughter)", active: true },
    { address: "b2", wallet: "SIPHO", label: "Sipho (son)", active: false },
  ],
} as unknown as Parameters<typeof estateRecipients>[0];

describe("estateRecipients", () => {
  it("the owner sees his child by name (not 'Someone else' and a raw address)", () => {
    const r = estateRecipients(snap, "OWNER");
    expect(r[0]).toEqual({ label: "Lerato", address: "LERATO", relationship: "daughter" });
    expect(r.map((x) => x.address)).toEqual(["LERATO", "V1", "V2", "V3"]);
  });

  it("never lists the sender; a family member sees the owner", () => {
    const r = estateRecipients(snap, "LERATO");
    expect(r.some((x) => x.address === "LERATO")).toBe(false);
    expect(r.at(-1)).toEqual({ label: "Thabo Mokoena", address: "OWNER", relationship: "estate owner" });
  });

  it("one entry per wallet: the estate's names win over device labels", () => {
    expect(mergeRecipients([{ label: "Lerato", address: "LERATO" }], [{ label: "My test wallet", address: "LERATO" }, { label: "Pieter", address: "P" }]))
      .toEqual([{ label: "Lerato", address: "LERATO" }, { label: "Pieter", address: "P" }]);
  });

  it("never offers a removed person or an empty seat (R16)", () => {
    const snap = {
      estate: { owner: "O", ownerName: "Owner", verifiers: ["V", "11111111111111111111111111111111", "W"], verifierNames: ["One", "Two", "Three"] },
      beneficiaries: [{ wallet: "B", label: "Left (son)", active: false }],
    } as unknown as Parameters<typeof estateRecipients>[0];
    expect(estateRecipients(snap, "me").map((r) => r.address)).toEqual(["V", "W", "O"]);
  });
});
