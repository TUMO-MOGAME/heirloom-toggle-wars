/** M4: the plan's asset terms are honoured when the asset is added. */
import { describe, expect, it } from "vitest";
import { nextPlanned, proceedsFromPlan } from "./planned";

const family = [{ wallet: "L", label: "Lerato (daughter)", active: true }, { wallet: "S", label: "Sipho", active: true }, { wallet: "N", label: "Naledi", active: false }];

describe("proceedsFromPlan", () => {
  it.each([
    ["The family vault, to fund the children's rules", "E"],
    ["Lerato", "L"],
    ["Give it to Sipho", "S"],
    ["S", "S"],
    ["Naledi", null],
    ["Lerato and Sipho", null],
    ["Sell it", null],
  ])("%j → %s", (text, want) => expect(proceedsFromPlan(text, "E", family)).toBe(want));
});

describe("nextPlanned", () => {
  const planned = [{ title: "2017 Toyota Corolla", floorPriceUsdt: 1, hardshipFloorUsdt: 1, askingPriceUsdt: 1, proceedsTo: "vault", hardshipPolicy: "" }];
  it("is the planned asset not added yet", () => {
    expect(nextPlanned(planned, [])?.title).toBe("2017 Toyota Corolla");
    expect(nextPlanned(planned, [{ title: "2017 toyota corolla" }])).toBeNull();
  });
});
