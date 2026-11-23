import { describe, expect, it } from "vitest";
import { batches } from "./client";
import type { WebpPhoto } from "./webp";

const photo = (bytes: number, n: number): WebpPhoto => ({ blob: new Blob([]), width: 1, height: 1, bytes, sha256: String(n).padStart(64, "0") });

describe("batches (request body limit)", () => {
  it("groups photos under the limit, in order, never splitting a photo", () => {
    const ps = [photo(1_400_000, 1), photo(1_400_000, 2), photo(1_400_000, 3), photo(200_000, 4)];
    const out = batches(ps, 3_800_000);
    expect(out.map((g) => g.map((p) => Number(p.sha256)))).toEqual([[1, 2], [3, 4]]);
    expect(batches([], 3_800_000)).toEqual([]);
  });
});
