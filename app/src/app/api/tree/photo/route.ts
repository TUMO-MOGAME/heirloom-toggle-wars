import { photoRoutes } from "@/lib/tree/server/photo-route";

const routes = photoRoutes();

/** GET /api/tree/photo?estate=… → the estate's tree photos (lib/tree/server/photo-route.ts). */
export const GET = routes.GET;
/** POST /api/tree/photo → a signed photo change: a living adult their own; the owner for a child, someone who has passed or an organisation. */
export const POST = routes.POST;
