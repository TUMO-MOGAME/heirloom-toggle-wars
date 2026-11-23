/** scripts/rehearse-second-review.ts: dry by default, devnet only. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEVNET_GENESIS, assertDevnet, rehearsalArgs } from "../../../../scripts/_rehearsal-cli";

const cluster = (genesis: string) => ({ getGenesisHash: async () => genesis });

describe("rehearse-second-review", () => {
  it("sends only with --send", () => {
    expect(rehearsalArgs(["payer.json"]).send).toBe(false);
    expect(rehearsalArgs(["payer.json", "--send"]).send).toBe(true);
  });

  it.each([[[]], [["--send"]], [["a.json", "b.json"]], [["a.json", "--yes"]], [["a.json", "--rpc"]], [["a.json", "--rpc", "--send"]]])("refuses %j", (argv) => {
    expect(() => rehearsalArgs(argv)).toThrow(/usage/);
  });

  it("accepts devnet", async () => {
    await expect(assertDevnet(cluster(DEVNET_GENESIS))).resolves.toBeUndefined();
  });

  it.each([
    ["mainnet", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"], ["testnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"],
    ["a local validator", "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"],
  ])("refuses %s", async (_, genesis) => {
    await expect(assertDevnet(cluster(genesis))).rejects.toThrow(/not devnet/);
  });

  it("checks the cluster before it reads the keypair, and loads no env file", () => {
    const src = readFileSync(path.resolve(process.cwd(), "../scripts/rehearse-second-review.ts"), "utf8");
    expect(src.indexOf("await assertDevnet(")).toBeGreaterThan(0);
    expect(src.indexOf("await assertDevnet(")).toBeLessThan(src.indexOf("readFileSync(keypairPath"));
    expect(src.indexOf("if (!send)")).toBeLessThan(src.indexOf("readFileSync(keypairPath"));
    expect(src).not.toMatch(/loadEnv|_shared/);
  });
});
