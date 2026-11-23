/** Every refusal of the program and of the chain service has plain words, in the four languages (plan §18.4). */
import { describe, expect, it } from "vitest";
import { PROGRAM_ERRORS } from "../lib/chain/program-errors";
import { common } from "./common";
import { disputes } from "./disputes";
import { guardians } from "./guardians";
import { safeguards } from "./safeguards";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";
import { safeguardsAf, safeguardsSt, safeguardsZu } from "./i18n/safeguards";

const SERVICE = [
  "AccountNotInitialized", "NotConfirmed", "InvalidAddress", "NoEstate", "residual", "recurring_payee", "agent_account", "bad_sale_tx",
  "sale_changed", "stale_sale", "co_sign_required", "own_offer", "agent_limit", "forbidden", "rate_limited", "not_served", "hash_mismatch",
  "already_reviewed", "Declined", "DeclineUnknown", "ReviewPending", "ScheduleChanged", "StaleApp", "ProgramMismatch", "program_mismatch", "has_usdt_account", "unneeded_signer", "members_only", "full", "storage_full", "decided", "daily_limit", "unconfirmed", "FileEmpty", "FileSize", "FileType",
];
const english = { ...guardians.errors, ...disputes.errors, ...common.errors, ...safeguards.errors } as Record<string, string>;

describe("errors in plain words", () => {
  it("every code has English", () => {
    expect([...PROGRAM_ERRORS, ...SERVICE].filter((code) => !Object.hasOwn(english, code))).toEqual([]);
  });

  it.each([["af", af, safeguardsAf], ["st", st, safeguardsSt], ["zu", zu, safeguardsZu]] as const)("and %s has each of them", (_n, t, rules) => {
    for (const [own, theirs] of [
      [guardians.errors, t.guardians?.errors], [disputes.errors, t.disputes?.errors], [common.errors, t.common?.errors], [safeguards.errors, rules.errors],
    ] as const) {
      expect(Object.keys(own).filter((code) => !(theirs as Record<string, string> | undefined)?.[code])).toEqual([]);
    }
  });
});
