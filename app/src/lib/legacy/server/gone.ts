import "server-only";
import { handler, json } from "@/lib/api/http";

/** The plain answer for the removed chat and live-call endpoints (plan §16.17). */
export const GONE_MESSAGE = "The legacy voice no longer talks or takes calls. It only plays the messages the parent wrote while alive.";

/** Route handler for an endpoint that used to make the parent's voice say new words: 410 Gone. */
export const gone = handler(async () => json({ error: GONE_MESSAGE, code: "gone" }, { status: 410 }));
