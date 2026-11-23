import { describe, expect, it } from "vitest";
import { guardians } from "./guardians";

describe("guardians copy", () => {
  it("explains every new contract error in plain words", () => {
    const names = ["NotMonitor", "ObjectionOpen", "ObjectionWindowOpen", "SuccessionPending", "NoSuccessionPending", "SeatVacant",
      "SeatsNotVacant", "NotConfirmer", "FallbackNotReady", "FallbackDone", "NoFallbackRecipient", "BadBackup", "BadMonitor", "DuplicateVerifier"];
    for (const n of names) expect(guardians.errors[n], n).toMatch(/\w{3,}/);
  });
  it("names the three trusted places and says only a fingerprint of a reason goes on-chain", () => {
    expect(guardians.seats).toHaveLength(3);
    expect(guardians.object.reasonHint).toMatch(/fingerprint/i);
  });
});
