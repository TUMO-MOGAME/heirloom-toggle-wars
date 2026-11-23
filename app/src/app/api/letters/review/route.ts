import { reviewRoutes } from "@/lib/letters/server/review-route";

const routes = reviewRoutes();

/** POST /api/letters/review → "Check my letter" or "Help me write it" for the estate owner (lib/letters/server/review-route.ts). */
export const POST = routes.POST;
/** The AI may take a while; the deterministic review answers at once. */
export const maxDuration = 30;
