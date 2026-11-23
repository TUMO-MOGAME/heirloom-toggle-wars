/** accept_offer's clock checks as the chain stores them: the Guard's window, an upheld sale objection, a hardship's stamp. */
import { describe, expect, it } from "vitest";
import { saleTimingFrom } from "./sale-timing";

const none = { guard: null, saleObjection: null, hardshipStamp: null };

describe("saleTimingFrom", () => {
  it("without a Guard nothing waits", () => {
    expect(saleTimingFrom(none, 5)).toEqual({ now: 5, objectionWindowSecs: null, saleObjectionUpheldAt: null, hardshipQuorumAt: null });
  });

  it("the Guard's window, clamped as the program reads it", () => {
    expect(saleTimingFrom({ ...none, guard: { objection_window_secs: 60 } }, 0).objectionWindowSecs).toBe(60);
    expect(saleTimingFrom({ ...none, guard: { objection_window_secs: -5 } }, 0).objectionWindowSecs).toBe(0);
    expect(saleTimingFrom({ ...none, guard: { objection_window_secs: 10 ** 9 } }, 0).objectionWindowSecs).toBe(180 * 86_400);
  });

  it("only an upheld sale objection refuses older offers; its raised_at is when it was decided", () => {
    const at = (status: string) => saleTimingFrom({ ...none, saleObjection: { status: { [status]: {} }, raised_at: 77 } }, 0).saleObjectionUpheldAt;
    expect([at("Upheld"), at("Dismissed"), at("Open")]).toEqual([77, null, null]);
  });

  it("a hardship stamp counts once its quorum was reached", () => {
    expect(saleTimingFrom({ ...none, hardshipStamp: { approved_at: 9 } }, 0).hardshipQuorumAt).toBe(9);
    expect(saleTimingFrom({ ...none, hardshipStamp: { approved_at: 0 } }, 0).hardshipQuorumAt).toBeNull();
  });
});
