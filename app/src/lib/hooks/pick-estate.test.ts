/** Which estate opens for a wallet in several estates (bug 1), and the shareable listing link (bug 16). */
import { describe, expect, it } from "vitest";
import { linkedEstate, listingLink, pickEstate, uniqueEstates, willView, type EstateChoice } from "./pick-estate";
import { demoEstateFirst, DEVNET_DEMO_ESTATE } from "../chain/demo-estate";

const OWN = "OwnEstateAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OtherEstateAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LISTED = "ListedEstateAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const e = (estate: string, role: string, ownerName = "Thabo Mokoena"): EstateChoice => ({ estate, role, ownerName });

describe("pickEstate", () => {
  // Lerato: daughter on the demo estate and on another family estate, and owner of her own plan.
  const lerato = demoEstateFirst([e(OWN, "owner", "Lerato"), e(OTHER, "beneficiary"), e(DEVNET_DEMO_ESTATE, "beneficiary")]);
  const base = { chosen: null, remembered: null, chain: true };

  it("a family member lands on the demo estate by default (the judges' path)", () => {
    expect(pickEstate(lerato, { ...base, role: "beneficiary" })).toBe(DEVNET_DEMO_ESTATE);
  });

  it("'Planning for my family' on the same wallet opens her own plan, not her father's", () => {
    expect(pickEstate(lerato, { ...base, role: "owner" })).toBe(OWN);
    // Even when the family member's last visit remembered her father's estate.
    expect(pickEstate(lerato, { ...base, role: "owner", remembered: DEVNET_DEMO_ESTATE })).toBe(OWN);
  });

  it("the remembered estate wins when the wallet still has the session's role there", () => {
    expect(pickEstate(lerato, { ...base, role: "beneficiary", remembered: OTHER })).toBe(OTHER);
  });

  it("a choice made in this visit wins over everything (the switcher)", () => {
    expect(pickEstate(lerato, { ...base, role: "owner", chosen: DEVNET_DEMO_ESTATE })).toBe(DEVNET_DEMO_ESTATE);
  });

  it("a remembered or chosen estate the wallet left is ignored", () => {
    expect(pickEstate(lerato, { ...base, role: "beneficiary", remembered: LISTED })).toBe(DEVNET_DEMO_ESTATE);
    expect(pickEstate(lerato, { ...base, role: "beneficiary", chosen: LISTED })).toBe(DEVNET_DEMO_ESTATE);
  });

  it("a listing link opens an estate the wallet has no role in (chain only)", () => {
    expect(pickEstate(lerato, { ...base, role: "buyer", chosen: LISTED, chosenByLink: true })).toBe(LISTED);
    expect(pickEstate([], { ...base, role: "buyer", chosen: LISTED, chosenByLink: true })).toBe(LISTED);
    // The demo holds one estate: a link to another is ignored there.
    expect(pickEstate([e(OWN, "buyer")], { ...base, chain: false, role: "buyer", chosen: LISTED, chosenByLink: true })).toBe(OWN);
  });

  it("no estate: the remembered one on chain (a buyer back from a listing), nothing in the demo", () => {
    expect(pickEstate([], { ...base, role: "buyer", remembered: LISTED })).toBe(LISTED);
    expect(pickEstate([], { ...base, chain: false, role: "buyer", remembered: LISTED })).toBeNull();
  });

  it("no estate in the session's role: the first one listed", () => {
    expect(pickEstate(lerato, { ...base, role: "verifier" })).toBe(DEVNET_DEMO_ESTATE);
  });
});

describe("uniqueEstates", () => {
  it("keeps one entry per estate (the first role)", () => {
    expect(uniqueEstates([e(OWN, "verifier"), e(OWN, "beneficiary"), e(OTHER, "monitor")])).toEqual([e(OWN, "verifier"), e(OTHER, "monitor")]);
  });
});

describe("listing link", () => {
  it("round-trips: the seller's link names the estate the buyer opens", () => {
    const link = listingLink("https://heirloom.example", LISTED);
    expect(link).toBe(`https://heirloom.example/car?estate=${LISTED}`);
    expect(linkedEstate(new URL(link).search)).toBe(LISTED);
  });

  it("ignores anything that is not an address", () => {
    expect(linkedEstate("")).toBeNull();
    expect(linkedEstate("?estate=")).toBeNull();
    expect(linkedEstate("?estate=<script>")).toBeNull();
    expect(linkedEstate("?estate=0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).toBeNull();
  });
});

describe("willView (generation 3)", () => {
  const me = "LERATO";
  it("the owner sees her signed plan; with no estate, the builder", () => {
    expect(willView(me, me, [], OWN)).toEqual({ kind: "locked" });
    expect(willView(null, me, [], null)).toEqual({ kind: "builder" });
  });
  it("her father's estate on screen: she is offered her own plan, never 'Your plan is signed'", () => {
    expect(willView("THABO", me, [e(DEVNET_DEMO_ESTATE, "beneficiary")], DEVNET_DEMO_ESTATE)).toEqual({ kind: "startOwn" });
  });
  it("she already has her own plan: open it (signing again would overwrite her will)", () => {
    expect(willView("THABO", me, [e(DEVNET_DEMO_ESTATE, "beneficiary"), e(OWN, "owner", "Lerato")], DEVNET_DEMO_ESTATE)).toEqual({ kind: "openOwn", estate: OWN });
  });
});
