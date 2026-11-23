import { estateMetaRoutes } from "@/lib/estate-meta/route";

const routes = estateMetaRoutes();

/** GET /api/estate-meta?estate=… → display names (off-chain, POPIA-scoped). */
export const GET = routes.GET;

/** POST /api/estate-meta → a signed save of the names by the owner, or a buyer's own name (lib/estate-meta/route.ts). */
export const POST = routes.POST;
