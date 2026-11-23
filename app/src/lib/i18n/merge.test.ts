import { describe, expect, it } from "vitest";
import { landing } from "@/content/landing";
import { common } from "@/content/common";
import { screens } from "@/content/screens";
import { pay } from "@/content/pay";
import { assistant } from "@/content/assistant";
import { guardians } from "@/content/guardians";
import { assets } from "@/content/assets";
import { site } from "@/content/site";
import { disputes } from "@/content/disputes";
import type { Bundle } from "@/content/i18n/types";
import { af } from "@/content/i18n/af";
import { st } from "@/content/i18n/st";
import { zu } from "@/content/i18n/zu";
import { mergeCopy } from "./merge";
import { isLocale } from "./locales";
import { unmark } from "@/lib/marked";

/** Partial slices (screens, assistant) that must still be translated in full: the newer guardians-era screens. */
const fullSlices = (t: Bundle) => ({
  "screens.estate.checkIn": [screens.estate.checkIn, t.screens.estate?.checkIn],
  "screens.estate.forYou.ownerClear": [screens.estate.forYou.ownerClear, t.screens.estate?.forYou?.ownerClear],
  "screens.audit": [screens.audit, t.screens.audit],
  "screens.handover": [screens.handover, t.screens.handover],
  "screens.car.sold.openPack": [screens.car.sold.openPack, t.screens.car?.sold?.openPack],
  "screens.car.sold.openPackHint": [screens.car.sold.openPackHint, t.screens.car?.sold?.openPackHint],
  "assistant.publicRecord": [assistant.publicRecord, t.assistant.publicRecord],
  "screens.start.phone": [screens.start.phone, t.screens.start?.phone],
  "screens.bills": [screens.bills, t.screens.bills],
  "screens.statement": [screens.statement, t.screens.statement],
  "screens.estate.activity.statement": [screens.estate.activity.statement, t.screens.estate?.activity?.statement],
  "screens.estate.activity.tree": [screens.estate.activity.tree, t.screens.estate?.activity?.tree],
  // The will review: the plan the owner reads and signs.
  "screens.will.preview": [screens.will.preview, t.screens.will?.preview],
  "screens.will.review": [screens.will.review, t.screens.will?.review],
  "screens.will.done": [screens.will.done, t.screens.will?.done],
  "screens.will.locked": [screens.will.locked, t.screens.will?.locked],
} as Record<string, [unknown, unknown]>);

/**
 * English on purpose (see content/i18n/types.ts): the suggested chat replies the on-device demo agent
 * matches in English, the scripted voice preview, the drafts sent to the agent, and the site's brand,
 * metadata, colours, URLs, screenshots and icon credit link.
 */
const keptEnglish = /^(screens\.will\.suggestions|assistant\.suggestions|assistant\.voicePreview|assistant\.home\.composer\.(sendMoneyDraft|defaultMessage)|site\.(name|shortName|tagline|title|description|url|themeLight|themeDark|accent|ogAlt|screenshots|footer\.(linksTitle|programId|iconCredit\.(linkText|href))))(\.|\[|$)/;

/** Every English key in the partial slices (screens, assistant, site) with no translation, as `path: English`. */
const untranslated = (t: Bundle): string[] => {
  const out: string[] = [];
  const walk = (en: unknown, tr: unknown, path: string) => {
    if (keptEnglish.test(path)) return;
    if (typeof en === "string") { if (typeof tr !== "string" || !tr.trim()) out.push(`${path}: ${en}`); return; }
    if (Array.isArray(en)) {
      if (!Array.isArray(tr) || tr.length !== en.length) out.push(`${path}: ${JSON.stringify(en)}`);
      else en.forEach((x, i) => walk(x, tr[i], `${path}[${i}]`));
      return;
    }
    if (en && typeof en === "object") for (const k of Object.keys(en)) walk((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
  };
  walk(screens, t.screens, "screens");
  walk(assistant, t.assistant, "assistant");
  walk(site, t.site, "site");
  return out;
};

/** How many `*marks*` a string carries; -1 when an asterisk is left over (unbalanced). */
const markCount = (s: string) => {
  const n = (s.match(/\*[^*\n]+\*/g) ?? []).length;
  return unmark(s).includes("*") ? -1 : n;
};

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

/** Walks English and a translation side by side, yielding every translated string with its English original. */
function* pairs(en: unknown, tr: unknown, path = ""): Generator<[string, string, string]> {
  if (typeof en === "string" && typeof tr === "string") { yield [path, en, tr]; return; }
  if (en && tr && typeof en === "object" && typeof tr === "object") {
    for (const k of Object.keys(tr)) yield* pairs((en as Record<string, unknown>)[k], (tr as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

describe("mergeCopy", () => {
  it("lays a partial translation over English and keeps untranslated slots", () => {
    // af is now complete, so leave two slots out by hand.
    const partial = { ...af.screens.estate, rate: undefined, scheduled: undefined };
    const out = mergeCopy(screens.estate, partial);
    expect(out.eyebrow).toBe("Boedel");
    expect(out.rate).toBe(screens.estate.rate);
    expect(out.scheduled.forWho).toBe(screens.estate.scheduled.forWho);
  });
  it("ignores empty strings and arrays of the wrong length", () => {
    expect(mergeCopy({ a: "x", b: ["1", "2"] }, { a: "", b: ["only"] })).toEqual({ a: "x", b: ["1", "2"] });
  });
  it("recognises the four locales only", () => {
    expect(["en", "zu", "st", "af"].every(isLocale)).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});

describe.each([["af", af], ["st", st], ["zu", zu]] as const)("%s translation", (_name, t) => {
  it("keeps every {placeholder} of the English copy", () => {
    const english = { landing, common, screens, pay, assistant, guardians, assets, disputes };
    const translated = { landing: t.landing, common: t.common, screens: t.screens, pay: t.pay, assistant: t.assistant, guardians: t.guardians, assets: t.assets, disputes: t.disputes };
    for (const [path, en, tr] of pairs(english, translated)) expect(placeholders(tr), path).toBe(placeholders(en));
  });

  it("marks the same number of key words as the English copy (the hand-drawn underline), with balanced asterisks", () => {
    const english = { landing, common, screens, pay, assistant, guardians, assets, disputes, site };
    const translated = { landing: t.landing, common: t.common, screens: t.screens, pay: t.pay, assistant: t.assistant, guardians: t.guardians, assets: t.assets, disputes: t.disputes, site: t.site };
    const wrong: string[] = [];
    for (const [path, en, tr] of pairs(english, translated)) {
      if (markCount(en) === 0 && !tr.includes("*")) continue;
      if (markCount(tr) !== markCount(en)) wrong.push(`${path}: ${JSON.stringify(tr)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("translates every guardians, assets and disputes key, every contract error name, the newer common keys and screens", () => {
    const missing: string[] = [];
    const walk = (en: unknown, tr: unknown, path: string) => {
      if (typeof en === "string") { if (typeof tr !== "string" || !tr.trim()) missing.push(path); return; }
      if (Array.isArray(en)) {
        if (!Array.isArray(tr) || tr.length !== en.length) missing.push(path);
        else en.forEach((x, i) => walk(x, tr[i], `${path}[${i}]`));
        return;
      }
      if (en && typeof en === "object") for (const k of Object.keys(en)) walk((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
    };
    walk(guardians, t.guardians, "guardians");
    walk(assets, t.assets, "assets");
    walk(disputes, t.disputes, "disputes");
    walk(common, t.common, "common");
    for (const [path, [en, tr]] of Object.entries(fullSlices(t))) walk(en, tr, path);
    walk(screens.start.form.roles, t.screens.start?.form?.roles, "screens.start.form.roles");
    expect(missing).toEqual([]);
    // Unknown keys would be typos that silently show English.
    for (const k of Object.keys(t.guardians.errors)) expect(Object.keys(guardians.errors), k).toContain(k);
  });

  it("keeps brand names, USD₮ and numbers as they are in guardians, assets, disputes and the newer screens", () => {
    const slices = fullSlices(t);
    const english = { guardians, assets, disputes, ...Object.fromEntries(Object.entries(slices).map(([k, v]) => [k, v[0]])) };
    const translated = { guardians: t.guardians, assets: t.assets, disputes: t.disputes, ...Object.fromEntries(Object.entries(slices).map(([k, v]) => [k, v[1]])) };
    for (const [path, en, tr] of pairs(english, translated)) {
      for (const keep of ["Heirloom", "USD₮", "Solana"]) if (en.includes(keep)) expect(tr, `${path} keeps ${keep}`).toContain(keep);
      // 6.4 and 6,4 are the same number (Afrikaans writes a decimal comma).
      const digits = (s: string) => (s.replace(/(\d),(\d)/g, "$1.$2").match(/\d+(?:\.\d+)?/g) ?? []).sort().join(",");
      expect(digits(tr), path).toBe(digits(en));
    }
  });

  it("translates every screen and agent line a user sees (lists any English key with no translation)", () => {
    const missing = untranslated(t);
    expect(missing, `${missing.length} untranslated:\n${missing.join("\n")}`).toEqual([]);
  });

  it("translates the whole sidebar and chat home (only the agent-read drafts stay English)", () => {
    const missing: string[] = [];
    const walk = (en: unknown, tr: unknown, path: string) => {
      if (/composer\.(sendMoneyDraft|defaultMessage)/.test(path)) return;
      if (typeof en === "string") { if (typeof tr !== "string" || !tr) missing.push(path); return; }
      if (en && typeof en === "object") for (const k of Object.keys(en)) walk((en as Record<string, unknown>)[k], (tr as Record<string, unknown> | undefined)?.[k], `${path}.${k}`);
    };
    walk(assistant.shell, t.assistant.shell, "shell");
    walk(assistant.home, t.assistant.home, "home");
    expect(missing).toEqual([]);
  });
});
