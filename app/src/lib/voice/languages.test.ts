import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locales";
import { VOICE_LANGUAGES, VOICE_LANGUAGE_CODES, isVoiceLanguage, languagesFor, resolveVoiceLanguage } from "./languages";

describe("spoken languages (plan §20)", () => {
  it("include every UI language, so the default always resolves", () => {
    for (const l of LOCALES) expect(isVoiceLanguage(l)).toBe(true);
  });

  it("English can do everything: the last resort is always valid", () => {
    expect(VOICE_LANGUAGES.en.support).toEqual({ agent: true, speech: true, listen: true });
  });

  it("never resolve to a language that can't do the job", () => {
    for (const cap of ["agent", "speech", "listen"] as const) {
      for (const chosen of [null, ...VOICE_LANGUAGE_CODES]) {
        for (const ui of LOCALES) {
          expect(VOICE_LANGUAGES[resolveVoiceLanguage(cap, chosen, ui)].support[cap]).toBe(true);
        }
      }
    }
  });

  it("prefer the chosen language, then the UI language", () => {
    expect(resolveVoiceLanguage("agent", "fr", "af")).toBe("fr");
    expect(resolveVoiceLanguage("listen", null, "zu")).toBe(VOICE_LANGUAGES.zu.support.listen ? "zu" : "en");
    expect(languagesFor("agent")).toContain("en");
  });
});
