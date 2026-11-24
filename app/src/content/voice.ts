/**
 * Copy for the spoken-language choice on a voice call (plan §20.1 "One agent, many languages"), added 24 Nov 2026.
 * Components read it with `useLocalized(voice, (t) => t.voice)`. {curly} values are filled at runtime.
 * English is the source; af/st/zu are in content/i18n/voice.ts and must translate every key (content/voice.test.ts).
 * The words the agent SAYS (first message, the simulated call) are per spoken language in content/voice-scripts.ts.
 */
export const voice = {
  picker: {
    label: "Spoken language",
    hint: "Heirloom speaks and listens in this language on the call. The screens stay in their own language.",
    same: "Same as the app ({name})",
    fallback: "Calls in {ui} aren't available yet, so Heirloom will speak {lang}.",
  },
  /** Under a simulated call whose words were machine translated. */
  machine: "Machine translated: awaiting a read by a first-language speaker.",
};

export type VoiceCopy = typeof voice;
