/** M9: the people who vote read the reason, never one whose words don't match the hash on-chain. */
import { describe, expect, it } from "vitest";
import { loadReasons, reasonBody, saveReason } from "./reasons-client";
import { sha256Hex } from "../agent/hash";
import { actionMessage } from "../access/messages";

describe("reasons", () => {
  it("saves with the signed action 'reason' over target|hash, and the text", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const signed: string[] = [];
    const f = (async (url: string, init: RequestInit) => { sent = { url, init }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await saveReason({ address: "W", signMessage: async (m) => { signed.push(m); return "00"; } }, "E", "T", "Paid twice", f);
    const hash = await sha256Hex("Paid twice");
    expect(sent!.url).toBe("/api/reasons");
    expect(JSON.parse(String(sent!.init.body))).toEqual({ estate: "E", target: "T", reason: "Paid twice" });
    const ts = JSON.parse((sent!.init.headers as Record<string, string>)["x-heirloom-action"]).ts;
    expect(signed[0]).toBe(actionMessage("reason" as never, "E", "W", ts, await sha256Hex(reasonBody("T", hash))));
  });

  it("keeps only reasons that match their hash", async () => {
    const good = await sha256Hex("Paid twice");
    const f = (async () => new Response(JSON.stringify({ reasons: [{ target: "T", hash: good, reason: "Paid twice" }, { target: "U", hash: good, reason: "forged" }] }))) as unknown as typeof fetch;
    expect(await loadReasons("E", f)).toEqual({ [good]: "Paid twice" });
    expect(await loadReasons("E", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch)).toEqual({});
  });
});
