import { describe, expect, it } from "vitest";
import { splitMarks, unmark } from "./marked";

describe("heading marks", () => {
  it("splits a marked word out of the copy", () => {
    expect(splitMarks("Plan for your *family*, now")).toEqual([
      { text: "Plan for your ", marked: false },
      { text: "family", marked: true },
      { text: ", now", marked: false },
    ]);
  });
  it("leaves copy without marks (and a lone asterisk) alone", () => {
    expect(splitMarks("No marks here")).toEqual([{ text: "No marks here", marked: false }]);
    expect(splitMarks("5 * 3")).toEqual([{ text: "5 * 3", marked: false }]);
  });
  it("strips marks for plain-text uses", () => {
    expect(unmark("The *estate* of {name}")).toBe("The estate of {name}");
    expect(unmark("*Two* *marks*")).toBe("Two marks");
  });
});
