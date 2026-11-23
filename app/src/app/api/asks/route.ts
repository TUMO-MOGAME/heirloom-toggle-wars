import { askRoutes } from "@/lib/ask/server/route";

const routes = askRoutes();

/** GET /api/asks?estate=… → the estate's request notes (lib/ask/server/route.ts). */
export const GET = routes.GET;
/** POST /api/asks → a signed note from the asker, or a signed decline from the owner. */
export const POST = routes.POST;
