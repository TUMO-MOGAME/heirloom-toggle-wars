import { describe, expect, it, vi } from "vitest";
import { formatUsdt, formatZar, toBase } from "./format";
import { AGENT_ACTION_EVENT, onAgentAction } from "./agent/action-events";

describe("cached number formatters", () => {
  it("match Number.toLocaleString exactly", () => {
    for (const v of [0, 0.005, 1.005, 12.5, 1234.567, 98765432.1, -3.2]) {
      const base = toBase(v);
      const n = Number(base) / 1e6;
      expect(formatUsdt(base)).toBe(`${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD₮`);
      expect(formatUsdt(base, { decimals: 0 })).toBe(`${n.toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} USD₮`);
      expect(formatZar(base, 17.31)).toBe(`R ${(n * 17.31).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`);
    }
  });
});

describe("agent action events (zod loaded on demand)", () => {
  it("delivers valid actions and drops invalid ones", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const seen: unknown[] = [];
    const off = onAgentAction((a) => seen.push(a));
    target.dispatchEvent(new CustomEvent(AGENT_ACTION_EVENT, { detail: { type: "navigate", path: "/family" } }));
    target.dispatchEvent(new CustomEvent(AGENT_ACTION_EVENT, { detail: { type: "navigate", path: "https://evil.example" } }));
    await vi.waitFor(() => expect(seen).toEqual([{ type: "navigate", path: "/family" }]));
    off();
    target.dispatchEvent(new CustomEvent(AGENT_ACTION_EVENT, { detail: { type: "showRule", rule: "r1" } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
