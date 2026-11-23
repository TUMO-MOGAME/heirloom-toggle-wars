import { lettersRoutes } from "@/lib/letters/server/route";

const routes = lettersRoutes();

/** POST /api/letters → a signed list, write or delete of letters for later (lib/letters/server/route.ts). */
export const POST = routes.POST;
