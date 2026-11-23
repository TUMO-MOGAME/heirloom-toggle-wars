import { describe, expect, it } from "vitest";
import { batched } from "./batch";

describe("batched reads", () => {
  it("makes one call for reads made together, answers in order and respects the limit", async () => {
    const calls: number[][] = [];
    const get = batched(async (keys: number[]) => { calls.push(keys); return keys.map((k) => k * 10); }, 2, 1);
    expect(await Promise.all([get(1), get(2), get(3)])).toEqual([10, 20, 30]);
    expect(calls).toEqual([[1, 2], [3]]);
  });

  it("fails every waiting read when the call fails", async () => {
    const get = batched<number, number>(async () => { throw new Error("429"); }, 10, 1);
    const results = await Promise.allSettled([get(1), get(2)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  });
});
