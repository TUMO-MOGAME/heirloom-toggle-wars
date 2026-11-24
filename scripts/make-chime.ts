/**
 * Makes the payment chime for spoken receipts (plan §20.1 item 3) with ElevenLabs Sound Effects, once, as a static file:
 * app/public/audio/payment-chime.mp3 (about 1 s, soft and warm). Played before a receipt is read aloud.
 *
 *   cd app && npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/make-chime.ts          # dry run: prints the request
 *   cd app && npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/make-chime.ts --send   # calls ElevenLabs, writes the file
 *
 * Endpoint (checked 24 Nov 2026, elevenlabs.io/docs/api-reference/text-to-sound-effects/convert):
 *   POST https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128
 *   header xi-api-key; body { text, duration_seconds (0.5-30), prompt_influence (0-1), loop, model_id }
 * ELEVENLABS_API_KEY is read from the environment only (export it in the shell; no .env file is read here).
 * After --send: listen to it, commit the file, then set PAYMENT_CHIME_SRC in app/src/lib/voice/receipts.ts to
 * "/audio/payment-chime.mp3" so the "Hear it" button plays it (until then the button plays the receipt alone).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEND = process.argv.includes("--send");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../app/public/audio/payment-chime.mp3");
const URL_ = "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128";
const BODY = {
  text: "A single soft, warm two-note confirmation chime, like a gentle marimba or felt piano, calm and reassuring, clean ending, no reverb tail, no voice",
  duration_seconds: 1,
  prompt_influence: 0.7,
  loop: false,
  model_id: "eleven_text_to_sound_v2",
};

async function main(): Promise<void> {
  console.log(`POST ${URL_}`);
  console.log(JSON.stringify(BODY, null, 2));
  console.log(`→ ${OUT}`);
  if (!SEND) {
    console.log("Dry run: nothing sent. Add --send to call ElevenLabs (uses ELEVENLABS_API_KEY from the environment).");
    return;
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set in this shell.");
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify(BODY),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs sound effects failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 1_000) throw new Error(`ElevenLabs returned only ${bytes.length} bytes; nothing written.`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);
  console.log(`Wrote ${bytes.length} bytes. Next: listen, commit it, and set PAYMENT_CHIME_SRC = "/audio/payment-chime.mp3".`);
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
