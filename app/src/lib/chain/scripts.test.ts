/** The seed and rehearsal scripts (plan §18.8): roles only on the ledger, every seat watched, titles with no authority. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.cwd(), "../scripts");
const scripts = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);

describe("scripts", () => {
  it.each(scripts)("%s: every on-chain label is a role or a public institution", (file, src) => {
    for (const m of src.matchAll(/ix\.add(?:Beneficiary|Payee)\([^\n]*/g)) {
      expect(m[0], file).toMatch(/publicBeneficiaryLabel|publicPayeeName|\blabel\)|\bownWallet\)/);
    }
    // The two names used above come from the helper.
    for (const m of src.matchAll(/const (?:label|ownWallet) = [^\n]*/g)) expect(m[0], file).toMatch(/publicPayeeName\(|publicBeneficiaryLabel\(/);
  });

  it.each(scripts)("%s: a title mint drops both authorities", (file, src) => {
    for (const m of src.matchAll(/createInitializeMint2Instruction\([^;\n]*?, 0, [^\n]*/g)) {
      expect(m[0], file).toMatch(/, null\)/);
      expect(src, file).toMatch(/AuthorityType\.MintTokens, null/);
    }
  });

  it.each(scripts)("%s: no seat is planned without a monitor", (file, src) => {
    expect(src, file).not.toMatch(/monitors: \[\]/);
  });

  it("the seeds refuse to downgrade a schedule", () => {
    for (const f of ["seed-demo.ts", "seed-guardians-assets.ts"]) expect(scripts.find(([name]) => name === f)![1]).toContain("recurring_payee");
  });
});
