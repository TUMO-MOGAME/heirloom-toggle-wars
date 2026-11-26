/**
 * What /try does before it opens the plan builder. Pure, so the rule is tested (try-plan.test.ts).
 *
 * - Not the demo (chain mode): nothing to reset; /will shows its own "no wallet" or plan state.
 * - A first demo visit (nothing saved in this browser): already Thabo with no plan, so go straight there.
 * - A returning demo visitor: reset the simulated estate to "fresh" and act as the demo owner, the same way the
 *   guided run and "Leave the demo" do (resetDemo("fresh") + wallet.switchTo).
 */
import type { WalletSession } from "@/lib/types";

/** Where /try sends people. No "?demo=" here: the reset is done in place, so the address stays plain /will. */
export const TRY_TARGET = "/will";

export type TryStep = "go" | "reset";

export function tryStep({ mock, freshVisit }: { mock: boolean; freshVisit: boolean }): TryStep {
  return mock && !freshVisit ? "reset" : "go";
}

/** The demo owner to act as: the first demo persona (Thabo) if present, else any owner. */
export function demoOwner(sessions: readonly WalletSession[], first: WalletSession | undefined): WalletSession | undefined {
  return (first && sessions.find((s) => s.address === first.address && s.role === "owner")) ?? sessions.find((s) => s.role === "owner");
}
