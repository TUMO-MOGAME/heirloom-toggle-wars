/** Background legacy reads never ask for the PIN (bug 13: a PIN sheet on page load on /claims for a child). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyApi, type LegacySigner } from "./client";

const signer = (quiet: boolean | undefined, sign = vi.fn(async () => "ab".repeat(64))): LegacySigner & { sign: typeof sign } => ({
  estate: "E", wallet: "W", sign, ...(quiet === undefined ? {} : { canSignQuietly: () => quiet }),
});

afterEach(() => vi.unstubAllGlobals());

describe("legacyApi.status({ quiet })", () => {
  it("a locked wallet: fails with code 'locked' without signing or calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const s = signer(false);
    await expect(legacyApi.status(s, { quiet: true })).rejects.toMatchObject({ code: "locked" });
    expect(s.sign).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unlocked wallet (or a page the person opened on purpose) signs and reads", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ book: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const quiet = signer(true);
    await legacyApi.status(quiet, { quiet: true });
    expect(quiet.sign).toHaveBeenCalledTimes(1);
    const locked = signer(false);
    await legacyApi.status(locked);
    expect(locked.sign).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
