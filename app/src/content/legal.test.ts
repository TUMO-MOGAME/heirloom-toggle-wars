/** The privacy policy names Flagsmith as an operator for the plan-builder test (plan §3, C6). */
import { describe, expect, it } from "vitest";
import { privacy, terms } from "./legal";

const text = (doc: { sections: readonly { heading: string; paragraphs?: readonly string[]; list?: readonly string[] }[] }, n: number) => {
  const s = doc.sections.find((x) => x.heading.startsWith(`${n}. `));
  return [...(s?.paragraphs ?? []), ...(s?.list ?? [])].join(" ");
};

describe("privacy: Flagsmith", () => {
  it("is an operator (section 7): who, what is sent, what is not, why, where, no cookies", () => {
    const ops = text(privacy, 7);
    expect(ops).toMatch(/Bullet Train Limited, trading as Flagsmith/);
    expect(ops).toMatch(/random anonymous id/);
    expect(ops).toMatch(/version of the plan builder/);
    expect(ops).toMatch(/first message, message, reviewed, signed/);
    expect(ops).toMatch(/numbers only/);
    expect(ops).toMatch(/never receives names, wallet addresses, email addresses or chat text/);
    expect(ops).toMatch(/sets no cookies/);
    expect(ops).toMatch(/United Kingdom/);
  });

  it("says what is collected and that the id is in local storage and can be cleared (section 3)", () => {
    const what = text(privacy, 3);
    expect(what).toMatch(/local storage/);
    expect(what).toMatch(/Clearing this site's data[^.]*removes the id/);
    // The old "no visitor-statistics tool" line must not stand unqualified now that the test exists.
    expect(what).toMatch(/the test above uses none\. Apart from it, this build has no visitor-statistics tool/);
  });

  it("covers how long it is kept (section 6) and the transfer (section 8)", () => {
    expect(text(privacy, 6)).toMatch(/plan-builder test/);
    expect(text(privacy, 8)).toMatch(/Flagsmith in the United Kingdom/);
  });

  it("the terms list no operators, so they need no change", () => {
    expect(JSON.stringify(terms)).not.toMatch(/Vercel|Supabase|Flagsmith/);
  });
});
