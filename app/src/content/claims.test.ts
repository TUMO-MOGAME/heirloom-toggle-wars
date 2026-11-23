/**
 * Copy claims only what the program does (plan §18.4 U6, §18.8): no absolutes it doesn't support, in English, and
 * the same corrections reach the other three languages.
 */
import { describe, expect, it } from "vitest";
import { landing } from "./landing";
import { screens } from "./screens";
import { common } from "./common";
import { assistant } from "./assistant";
import { guardians } from "./guardians";
import { privacy, terms } from "./legal";
import { site } from "./site";
import { af } from "./i18n/af";
import { st } from "./i18n/st";
import { zu } from "./i18n/zu";

function strings(v: unknown): string[] {
  return typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
}

/** What the second review found and the program doesn't support. */
const FALSE_CLAIMS = [
  /no dead ends?/i,
  /no one can freeze|nobody can freeze/i,
  /no personal names[^.]*on-chain/i,
  /never need(s)? sol|don't need sol|need no sol/i,
  /sells? to the (best|highest) offer/i,
  /nobody can change these rules|can't be changed by anyone/i,
  /including heirloom, can/i,
  /pays? (for )?itself/i,
  /paid automatically|go out automatically/i,
  /only to (approved )?institutions|the only places the vault can pay/i,
  /never take money for themselves/i,
  /money only ever moves/i,
  /pays? the institution directly|nothing is paid to you/i,
];

describe("claims the program supports", () => {
  it("makes none of the false ones", () => {
    const all = strings({ landing, screens, common, assistant, guardians, privacy, terms, site });
    for (const bad of FALSE_CLAIMS) expect(all.filter((s) => bad.test(s)), String(bad)).toEqual([]);
  });

  it("says who holds the upgrade key, that rent needs SOL and that the schedule runs daily", () => {
    expect(landing.proof.honest).toMatch(/upgrade key/);
    expect(strings(terms).join(" ")).toMatch(/upgrade key[\s\S]*once a day[\s\S]*rent/);
    expect(screens.start.phone.fees).toMatch(/rent/);
    expect(screens.estate.scheduled.body).toMatch(/once a day/);
  });

  it.each([["af", af], ["st", st], ["zu", zu]] as const)("%s carries the upgrade key and SOL for rent too", (_name, t) => {
    expect(t.landing.proof.honest).toMatch(/Heirloom/);
    expect(t.screens.start?.phone?.fees).toContain("SOL");
    expect(t.screens.will?.review?.limits).toHaveLength(screens.will.review.limits.length);
  });

  it("privacy: the device's copy of names, the starter's memo, and storage in Ireland only where switched on", () => {
    const text = strings(privacy).join(" ");
    expect(text).toMatch(/stays after you sign out/);
    expect(text).toMatch(/short hash of your wallet/);
    expect(text).toMatch(/only where it is switched on[^.]*Supabase Inc\., with data stored in Ireland/);
  });
});
