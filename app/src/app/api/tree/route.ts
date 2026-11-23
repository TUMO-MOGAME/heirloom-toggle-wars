import { treeRoutes } from "@/lib/tree/server/route";

const routes = treeRoutes();

/** GET /api/tree?estate=… → the estate's family links: relationships and hidden flags (lib/tree/server/route.ts). */
export const GET = routes.GET;
/** POST /api/tree → a signed change: the owner relates or unrelates two people; anyone hides or shows themselves. */
export const POST = routes.POST;
