/** The Trust Tree screen parts, rendered from the fixture: words, no amounts on any card, the reduced-motion path. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { tree as copy } from "@/content/tree";
import { treeAf } from "@/content/i18n/tree";
import { treeFixture, yearTs, FIXTURE_IDS as ID } from "@/lib/tree/fixture";
import { treeAtYear } from "@/lib/tree/timeline";
import type { KeptPromise } from "@/lib/tree/types";
import { PersonCardBody, cardTitle } from "./card";
import { TreeMap, travellersAt } from "./map";
import { TreeList } from "./list";
import { factsFor, keptText, namesList, roleTermText, shortLabel, yearsText, type Copy } from "./words";

const t = treeFixture("EST");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Money in any form: a currency, a rand amount, decimals, a percentage. */
const MONEY = /USD₮|USDT|\bR\s?\d|\$|€|£|\d[\d\s]*[.,]\d{2}\b|%|\bZAR\b/;

describe("words", () => {
  const at = treeAtYear(t, 2070);
  const nameOf = (id: string) => shortLabel(copy, at.people.find((p) => p.id === id), at.year);

  it("words every kind of kept promise in plain language", () => {
    const base: Omit<KeptPromise, "kind"> = { id: "k", by: ID.BONGANI, for: [ID.LERATO, ID.SIPHO], about: ID.THABO, estate: "E", count: 3, withOthers: 2, purpose: "Tuition", firstTs: yearTs(2034), lastTs: yearTs(2036), proofs: [], imagined: false };
    const w = (kind: KeptPromise["kind"], o: Partial<KeptPromise> = {}) => keptText(copy, { ...base, kind, ...o }, nameOf);
    expect(w("confirmedPassing")).toBe("Confirmed Thabo's passing, 2034–2036 (with 2 others)");
    expect(w("confirmedPassing", { withOthers: 1, lastTs: yearTs(2034) })).toBe("Confirmed Thabo's passing, 2034 (with 1 other)");
    expect(w("approvedPayments")).toBe("Approved 3 payments for Lerato and Sipho, 2034–2036");
    expect(w("approvedPayments", { count: 1 })).toBe("Approved 1 payment for Lerato and Sipho, 2034–2036");
    expect(w("answeredRequests", { for: [ID.LERATO] })).toBe("Answered 3 requests from Lerato, 2034–2036");
    expect(w("planPaid")).toBe("School and university fees for Lerato and Sipho, 2034–2036");
    expect(w("helpedHardship", { for: [ID.SIPHO] })).toBe("Helped Sipho through a hard time, 2034–2036");
    expect(w("guardianTerm", { for: [ID.NALEDI] })).toBe("Guardian of Naledi, 2034–2036");
    expect(w("carriedOutFallback")).toBe("Carried out Thabo's fallback plan, 2034–2036");
    expect(w("raisedUpheldChallenge")).toBe("Raised a challenge that was upheld, 2034–2036");
    expect(w("challengeUpheld")).toBe("A challenge against one of their claims was upheld, 2034–2036");
  });

  it("words role terms, open-ended ones with 'since'", () => {
    const e = t.edges.find((x) => x.role === "guardian" && x.to === ID.BONGANI)!;
    expect(roleTermText(copy, e, nameOf)).toBe("Guardian in Thabo's plan, 2026–2036");
    expect(roleTermText(copy, { ...e, toTs: undefined }, nameOf)).toBe("Guardian in Thabo's plan, since 2026");
    expect(yearsText(copy, 2041, 2041)).toBe("2041");
    expect(namesList(["A", "B", "C"], "and")).toBe("A, B and C");
  });

  it("counts the people who trusted someone and the promises they kept", () => {
    const f = factsFor(treeAtYear(t, 2040), ID.BONGANI);
    expect(f.trustedBy).toBe(1);
    expect(f.roles.map((r) => r.role).sort()).toEqual(["guardian", "trustedPerson"]);
    expect(f.keptCount).toBe(1 + 1 + 12 + 1);
  });

  it("names a hidden adult 'A family member' and a child by first name only", () => {
    const now = treeAtYear(t, 2026);
    expect(shortLabel(copy, now.people.find((p) => p.id === ID.KAGISO), 2026)).toBe("A family member");
    expect(shortLabel(copy, now.people.find((p) => p.id === ID.NALEDI), 2026)).toBe("Naledi");
    expect(cardTitle(now, ID.NALEDI, copy)).toBe("Naledi");
    expect(cardTitle(treeAtYear(t, 2040), ID.NALEDI, copy)).toBe("Naledi Mokoena");
  });
});

describe("person cards", () => {
  const render = (year: number, id: string, viewer: string | null = null, c: Copy = copy) =>
    text(renderToStaticMarkup(createElement(PersonCardBody, { at: treeAtYear(t, year), id, copy: c, mock: true, viewer, onHide: () => {} })));

  it("never show an amount, on any card, in any year, in English or Afrikaans", () => {
    for (const year of [1995, 2026, 2034, 2041, 2062, 2086]) {
      for (const p of t.people) {
        for (const c of [copy, treeAf]) {
          const s = render(year, p.id, null, c);
          expect(s, `${p.id} ${year}`).not.toMatch(MONEY);
        }
      }
    }
  });

  it("show the facts, roles, kept promises with proof and what was received", () => {
    const s = render(2070, ID.LERATO);
    expect(s).toContain("Trusted by 1 person · Kept");
    expect(s).toContain("Heir in Thabo's plan, 2026–2034");
    expect(s).toContain("Answered 6 requests from Amahle, 2049–2054");
    expect(s).toContain("A car · 2017 Toyota Corolla");
    expect(s).toContain("(simulated)");
  });

  it("show no details for a hidden adult or a child", () => {
    expect(render(2040, ID.KAGISO)).toContain("chose not to be shown by name");
    expect(render(2040, ID.KAGISO)).not.toContain("Kept");
    const child = render(2026, ID.NALEDI);
    expect(child).toContain("Only a first name is shown for children.");
    expect(child).not.toContain("Trusted by");
  });

  it("offer 'Hide me' only to a living adult on their own card", () => {
    expect(render(2026, ID.SIPHO, ID.SIPHO)).toContain("Hide me from the tree");
    expect(render(2026, ID.SIPHO, ID.LERATO)).not.toContain("Hide me");
    expect(render(2026, ID.NALEDI, ID.NALEDI)).not.toContain("Hide me");
    expect(render(2040, ID.THABO, ID.THABO)).not.toContain("Hide me");
  });
});

describe("reduced motion", () => {
  it("renders the map with every person and line in place, and no drawing masks or travelling assets", () => {
    const at = treeAtYear(t, 2034);
    expect(travellersAt(at, copy).length).toBe(1);
    const html = renderToStaticMarkup(createElement(TreeMap, { at, copy, width: 1100, reduced: true, viewer: null, onOpen: () => {} }));
    expect(html).not.toContain("<mask");
    expect(html).not.toContain("var(--amber)\" stroke=\"var(--bg)\" stroke-width=\"2.5\"");
    expect(html).toContain("Uncle Bongani");
    expect(html.match(/role="button"/g)?.length).toBe(at.people.length);
    expect(html.match(/tree-trust/g)?.length).toBe(at.edges.length);
    expect(text(html)).not.toMatch(MONEY);
  });

  it("draws with masks when motion is allowed", () => {
    const at = treeAtYear(t, 2034);
    const html = renderToStaticMarkup(createElement(TreeMap, { at, copy, width: 1100, reduced: false, viewer: null, onOpen: () => {} }));
    expect(html).toContain("<mask");
  });

  it("renders the phone list by generation", () => {
    const at = treeAtYear(t, 2041);
    const html = text(renderToStaticMarkup(createElement(TreeList, { at, copy, reduced: true, viewer: ID.LERATO, onOpen: () => {} })));
    expect(html).toContain("Generation 1");
    expect(html).toContain("Generation 4");
    expect(html).toContain("Lerato · You");
    expect(html).not.toMatch(MONEY);
  });
});
