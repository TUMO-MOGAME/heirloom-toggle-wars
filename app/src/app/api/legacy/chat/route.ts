import { gone } from "@/lib/legacy/server/gone";

/**
 * POST /api/legacy/chat was a text chat in the parent's voice. Removed on 18 Nov 2026 (plan §16.17): the voice only
 * ever says words its owner wrote or approved while alive, so it no longer answers questions. 410 Gone.
 */
export const POST = gone;
