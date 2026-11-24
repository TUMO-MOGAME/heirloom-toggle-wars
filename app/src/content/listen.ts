/**
 * Copy for voice typing (plan §20.1 item 2): the microphone in the chat composer and the plan builder. Components read
 * it with `useLocalized(listen, (t) => t.listen)`. {language} is the spoken language's own name ("isiZulu").
 * English is the source; af/st/zu are in content/i18n/listen.ts and must translate every key.
 */
export const listen = {
  start: "Speak instead of typing ({language})",
  stop: "Stop and turn my words into text",
  checking: "Getting voice typing ready…",
  listening: "Listening in {language}. Tap the microphone again when you're done (up to a minute).",
  transcribing: "Turning your words into text…",
  done: "Your words are in the box. Check them, then send.",
  notice: "Your recording is sent to ElevenLabs to turn it into text and is not kept.",
  privacyLink: "Privacy",
  unavailable: "Voice typing needs the live service, which isn't switched on here. Please type instead.",
  errors: {
    blocked: "The microphone is blocked. Allow it in your browser's settings, or type instead.",
    unsupported: "This browser can't record here. Please type instead.",
    empty: "We didn't catch any words. Try again a little closer to the microphone.",
    busy: "Voice typing is busy right now. Please wait a minute, or type instead.",
    failed: "Voice typing didn't work this time. Please try again, or type instead.",
  },
};

export type ListenCopy = typeof listen;
