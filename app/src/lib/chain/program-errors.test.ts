/** Every refusal of the program reaches the family in plain words that start with the error's name. */
import { describe, expect, it } from "vitest";
import { getIdl } from "./idl";
import { PLAIN, PROGRAM_ERRORS, programErrorByCode, programFailure } from "./program-errors";
import { confirmOrThrow, humanizeProgramError } from "./tx";
import { explainSendError } from "../wallet/wdk";

const idlErrors = getIdl().errors ?? [];
const anchorLog = (name: string, code: number, message: string, account?: string) =>
  `Program log: AnchorError ${account ? `caused by account: ${account}` : "occurred"}. Error Code: ${name}. Error Number: ${code}. Error Message: ${message}.`;

describe("program errors", () => {
  it("the list is the IDL's: names and codes", () => {
    const norm = (s: string) => s.replace(/_/g, "").toLowerCase();
    expect(idlErrors.map((e) => [e.code, norm(e.name)])).toEqual(PROGRAM_ERRORS.map((n, i) => [6000 + i, norm(n)]));
  });

  it.each([
    [6053, "NotParticipant"], [6054, "OwnApproval"], [6055, "CoSignerRequired"], [6056, "ListingStillOpen"], [6057, "InvalidWallet"],
    [6058, "ReportChanged"], [6059, "DeathReportOpen"], [6060, "ClaimFromEndedRule"], [6061, "OfferChanged"],
    [6062, "DeathDisproved"], [6063, "OfferTooOld"],
  ] as const)("%i %s: plain words from its log, its hex code and a transaction status", (code, name) => {
    const plain = `${name}: ${PLAIN[name]}`;
    expect(PLAIN[name].length).toBeGreaterThan(20);
    expect(programFailure([anchorLog(name, code, "program words")])).toBe(plain);
    expect(programFailure(`Program X failed: custom program error: 0x${code.toString(16)}`)).toBe(plain);
    expect(programFailure(JSON.stringify({ InstructionError: [0, { Custom: code }] }))).toBe(plain);
  });

  it("3012 says what is missing: a removed payee, a family member, or neither", () => {
    const missing = (account?: string) =>
      programFailure([anchorLog("AccountNotInitialized", 3012, "The program expected this account to be already initialized", account)])!;
    expect(missing("payee_account")).toMatch(/^AccountNotInitialized: This payee was removed/);
    expect(missing("beneficiary_account")).toMatch(/not a family member/);
    expect(missing("something_new")).toMatch(/no longer there/);
    expect(programErrorByCode(3012)).toMatch(/^AccountNotInitialized: .*no longer there/);
  });

  it("keeps the program's words for the others", () => {
    expect(programFailure([anchorLog("BelowFloor", 6016, "Offer is below the floor price")])).toBe("BelowFloor: Offer is below the floor price");
  });

  it("claims nothing it doesn't know", () => {
    expect(programFailure("fetch failed")).toBeNull();
    expect(programFailure("custom program error: 0x1")).toBeNull();
    expect(programErrorByCode(6000 + PROGRAM_ERRORS.length)).toBeNull();
  });

  it("logs, a confirmed failure and a wallet's send all use it", async () => {
    const log = anchorLog("OfferChanged", 6061, "The offer is no longer the amount that was agreed");
    expect(humanizeProgramError([log])).toBe(`OfferChanged: ${PLAIN.OfferChanged}`);
    expect(explainSendError({ context: { logs: [log] } })).toBe(`Rejected by the Heirloom program: OfferChanged: ${PLAIN.OfferChanged}`);
    const conn = {
      getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, { Custom: 6059 }] } }] }),
      getTransaction: async () => null,
    };
    await expect(confirmOrThrow("sig", conn as never)).rejects.toThrow(/^DeathReportOpen: /);
  });
});
