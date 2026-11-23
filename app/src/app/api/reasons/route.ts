import { reasonsRoutes } from "@/lib/server/reasons";

const routes = reasonsRoutes();

/** GET /api/reasons?estate=… → the written reasons of the estate's disputes and objections (members only). */
export const GET = routes.GET;
/** POST /api/reasons → the person who raised a dispute or objection saves its words (lib/server/reasons.ts). */
export const POST = routes.POST;
