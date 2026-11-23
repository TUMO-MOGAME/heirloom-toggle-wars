/** Second security review on the Trust Tree: reused rule slots, released titles and cleared death reports. */
import { describe, expect, it } from "vitest";
import { mergeEvents, snapshotFacts, treeEventsFromChain, type RawChainEvent } from "./events";
import type { EstateSnapshot } from "../service/types";

const ev = (name: string, ts: number, data: Record<string, unknown>): RawChainEvent => ({ name, ts, signature: `s${ts}`, data });
const read = (...events: RawChainEvent[]) => treeEventsFromChain(events, { estate: "E" });

describe("the tree after the second security review", () => {
  it("what an earlier rule paid is never read as the rule that reused its slot", () => {
    const out = read(
      ev("ScheduledPaid", 10, { rule: "R" }),
      ev("ClaimSubmitted", 11, { claim: "C0", rule: "R", beneficiary: "B" }),
      ev("RuleReused", 20, { rule: "R", first_claim_id: 65_536 }),
      ev("ClaimPaid", 25, { claim: "C1", rule: "R" }),
      ev("RuleReused", 30, { rule: "R", first_claim_id: 131_072 }),
      ev("ScheduledPaid", 40, { rule: "R" }),
    );
    expect(out.map((e) => ("rule" in e ? e.rule : ""))).toEqual(["R#0", "R#0", "R#1", "R"]);
  });

  it("the same from an account snapshot", () => {
    const claim = (id: number) => ({ address: `C${id}`, rule: "R", id, beneficiary: "B", approvals: [], status: "Paid", createdAt: 1 });
    const snap = {
      estate: { address: "E", owner: "O", verifiers: [], status: "Active", death: { attestations: [] }, lastHeartbeat: 1 },
      beneficiaries: [], rules: [{ address: "R", category: "Books", beneficiary: "N", claimCount: 65_537 }],
      claims: [claim(3), claim(65_536)], hardships: [], assets: [], activity: [],
    } as unknown as EstateSnapshot;
    const paid = snapshotFacts(snap).filter((e) => e.kind === "ClaimPaid");
    expect(paid.map((e) => (e as { rule: string }).rule)).toEqual(["R#0", "R"]);
  });

  it("one payment under an earlier rule stays one, when the activity line only knows the slot", () => {
    const history = read(ev("ScheduledPaid", 10, { rule: "R" }), ev("RuleReused", 20, { rule: "R", first_claim_id: 65_536 }));
    const line = { estate: "E", ts: 10, sig: "s10", kind: "ScheduledPaid" as const, rule: "R" };
    expect(mergeEvents(history, [line]).map((e) => (e as { rule?: string }).rule)).toEqual(["R#0"]);
  });

  it("a released title leaves the tree; registered again, it is back", () => {
    const registered = ev("AssetRegistered", 1, { asset: "A" });
    const released = ev("AssetReleased", 2, { asset: "A" });
    expect(read(registered, released)).toEqual([]);
    expect(read(registered, released, ev("AssetRegistered", 3, { asset: "A" })).map((e) => e.ts)).toEqual([3]);
  });

  it("a cleared report credits nobody, like a veto", () => {
    expect(read(ev("SeatDeathReportCleared", 5, { seat_index: 2 }))).toMatchObject([{ kind: "SeatDeathVetoed", seat: 2 }]);
  });
});
