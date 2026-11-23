import { handler, json, rateLimit } from "@/lib/api/http";
import { APP_BUILD } from "@/lib/chain/release";

/**
 * GET /api/build → { build }: which build the server runs (lib/chain/release.ts APP_BUILD). A tab asks before every
 * write and, when its own build differs, tells the person to reload before anything is signed (plan §18.9 C1).
 * No RPC call, so it is asked as often as people write.
 */
export const GET = handler(async (req) => {
  rateLimit(req, "build", 600);
  return json({ build: APP_BUILD });
});
