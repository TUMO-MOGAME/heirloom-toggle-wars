import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRoleOnly, publicBeneficiaryLabel, publicPayeeName, withPrivateNames } from "./public-names";

describe("no personal names on the public ledger", () => {
  it("a family member is written as a role", () => {
    expect(publicBeneficiaryLabel(0)).toBe("Family member 1");
    expect(isRoleOnly(publicBeneficiaryLabel(11))).toBe(true);
  });

  it("only universities and schools keep their names", () => {
    const family = new Set(["child"]);
    expect(publicPayeeName({ name: "University of Cape Town", kind: "University", wallet: "u" }, family)).toBe("University of Cape Town");
    expect(publicPayeeName({ name: "Mrs N. Dlamini", kind: "Landlord", wallet: "l" }, family)).toBe("Approved landlord");
    expect(publicPayeeName({ name: "Granny Thandi", kind: "Other", wallet: "g" }, family)).toBe("Approved payee");
    expect(publicPayeeName({ name: "Naledi Mokoena", kind: "School", wallet: "child" }, family)).toBe("Family member's own wallet");
  });

  it("the family still sees its names; older estates' labels are untouched", () => {
    const out = withPrivateNames({
      beneficiaries: [
        { address: "a", wallet: "child", label: "Family member 1", active: true },
        { address: "b", wallet: "old", label: "Sipho (son)", active: true },
      ],
      payees: [{ address: "c", wallet: "child", kind: "Other" as const, name: "Family member's own wallet" }],
    }, { child: "Lerato (daughter)", old: "someone else" });
    expect(out.beneficiaries.map((b) => b.label)).toEqual(["Lerato (daughter)", "Sipho (son)"]);
    expect(out.payees[0].name).toBe("Lerato's own wallet");
  });

  it("the chain service has no other way to write a label", () => {
    const src = readFileSync(path.resolve(process.cwd(), "src/lib/service/chain.ts"), "utf8");
    const writes = [...src.matchAll(/ix\.add(Beneficiary|Payee)\([^\n]*/g)].map((m) => m[0]);
    expect(writes.length).toBe(3);
    for (const w of writes) expect(w).toMatch(/publicBeneficiaryLabel|publicPayeeName/);
  });
});
