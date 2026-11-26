/**
 * /actions.json (Solana Actions): tells blink clients that the public page /chip-in/<estate> is an Action served by
 * /api/chipin/<estate>. Cross-origin readable by spec (Access-Control-Allow-Origin: *), on this file only.
 */
import { ACTIONS_CORS_HEADERS, ACTIONS_JSON } from "@/lib/chipin/actions";

const headers = { ...ACTIONS_CORS_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" };

export function GET(): Response {
  return new Response(JSON.stringify(ACTIONS_JSON), { headers });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers });
}
