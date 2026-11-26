import { describe, expect, it } from "vitest";
import type { WalletSession } from "@/lib/types";
import { personaSessions } from "@/lib/wallet/personas";
import { firstDemoPersona } from "@/lib/service/fresh-visit";
import { tryDemo } from "@/content/try";
import { demoOwner, TRY_TARGET, tryStep } from "./try-plan";

describe("/try", () => {
  it("lands on the plan builder, the screen under test", () => {
    expect(TRY_TARGET).toBe("/will");
  });

  it("resets the demo only for a returning demo visitor", () => {
    expect(tryStep({ mock: true, freshVisit: true })).toBe("go");
    expect(tryStep({ mock: true, freshVisit: false })).toBe("reset");
    expect(tryStep({ mock: false, freshVisit: false })).toBe("go");
    expect(tryStep({ mock: false, freshVisit: true })).toBe("go");
  });

  it("acts as the first demo persona, who is the owner", () => {
    const sessions = personaSessions();
    const owner = demoOwner(sessions, firstDemoPersona());
    expect(owner?.address).toBe(firstDemoPersona().address);
    expect(owner?.role).toBe("owner");
  });

  it("falls back to any owner, and to nobody when there is none", () => {
    const s = (address: string, role: WalletSession["role"]) => ({ ...firstDemoPersona(), address, role }) as WalletSession;
    expect(demoOwner([s("a", "beneficiary"), s("b", "owner")], s("a", "beneficiary"))?.address).toBe("b");
    expect(demoOwner([s("a", "beneficiary")], undefined)).toBeUndefined();
  });

  it("keeps its copy in content", () => {
    for (const v of Object.values(tryDemo)) expect(v.trim().length).toBeGreaterThan(0);
  });
});
