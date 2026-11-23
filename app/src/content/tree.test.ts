/** Trust Tree copy: every key translated in af/st/zu with the same {placeholders} and marks; no money words or scores. */
import { describe, expect, it } from "vitest";
import { tree } from "./tree";
import { treeAf, treeSt, treeZu } from "./i18n/tree";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";
import { assistant } from "./assistant";
import { common } from "./common";
import { screens } from "./screens";
import type { KeptKind, RelationshipKind, TrustRole, AssetStepKind } from "@/lib/tree/types";

function* strings(en: unknown, tr: unknown, path = ""): Generator<[string, string, unknown]> {
  if (typeof en === "string") { yield [path, en, tr]; return; }
  if (en && typeof en === "object") for (const k of Object.keys(en)) yield* strings((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
}
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
const marks = (s: string) => (s.match(/\*/g) ?? []).length;

describe("English tree copy", () => {
  it("has words for every kept promise, role, relationship and asset step", () => {
    const kept: KeptKind[] = ["confirmedPassing", "approvedPayments", "answeredRequests", "planPaid", "helpedHardship", "guardianTerm", "carriedOutFallback", "raisedUpheldChallenge", "challengeUpheld"];
    const roles: TrustRole[] = ["trustedPerson", "guardian", "heir", "beneficiary", "successor", "monitor", "fallback"];
    const rels: RelationshipKind[] = ["parentOf", "spouseOf", "siblingOf"];
    const steps: AssetStepKind[] = ["registered", "heldByPlan", "passedTo", "soldUnderRules"];
    for (const k of kept) expect(tree.kept[k], k).toBeTruthy();
    for (const r of roles) expect(tree.roles[r], r).toBeTruthy();
    for (const r of rels) { expect(tree.relationships[r], r).toBeTruthy(); expect(tree.owner.kinds[r], r).toBeTruthy(); }
    for (const s of steps) expect(tree.assetSteps[s], s).toBeTruthy();
  });

  it("never talks about money, prices or scores", () => {
    for (const [path, en] of strings(tree, tree)) {
      // "a value or a price" only appears to say the tree never shows one.
      if (path === ".paths.body") continue;
      expect(en, path).not.toMatch(/USD₮|\bR\s?\d|\$|\bscore|\bpercent|%|\brand\b|\bbalance|\bprice/i);
    }
  });
});

describe.each([["af", treeAf, af], ["st", treeSt, st], ["zu", treeZu, zu]] as const)("%s tree copy", (_n, t, bundle) => {
  it("is the bundle's tree slice", () => expect(bundle.tree).toBe(t));

  it("translates every key, keeping placeholders, the one mark, Solana, Heirloom and SHA-256", () => {
    const wrong: string[] = [];
    for (const [path, en, tr] of strings(tree, t)) {
      if (typeof tr !== "string" || !tr.trim()) { wrong.push(`${path}: missing`); continue; }
      if (placeholders(tr) !== placeholders(en)) wrong.push(`${path}: placeholders`);
      if (marks(tr) !== marks(en)) wrong.push(`${path}: marks`);
      for (const keep of ["Solana", "Heirloom", "SHA-256"]) if (en.includes(keep) && !tr.includes(keep)) wrong.push(`${path}: ${keep}`);
    }
    expect(wrong).toEqual([]);
  });

  it("translates the menu item and the links to the tree", () => {
    expect(bundle.assistant.shell?.nav?.tree).toBeTruthy();
    expect(bundle.assistant.shell?.nav?.tree).not.toBe(assistant.shell.nav.tree);
    expect(bundle.common.proof.tree).toBeTruthy();
    expect(bundle.common.proof.treeHint).not.toBe(common.proof.treeHint);
    expect(bundle.screens.estate?.activity?.tree).toBeTruthy();
    expect(bundle.screens.estate?.activity?.tree).not.toBe(screens.estate.activity.tree);
  });
});
