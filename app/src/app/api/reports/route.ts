import { z } from "zod";
import { handler, json, rateLimit } from "@/lib/api/http";
import { getReports } from "@/lib/db";
import { requireMember } from "@/lib/access/server";

/** More than an estate has; a longer list is answered for its first REPORTS_MAX rather than refused whole. */
const REPORTS_MAX = 500;
const hashes = z.array(z.string().regex(/^[0-9a-f]{64}$/));
const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

/**
 * GET /api/reports?estate=…&hashes=h1,h2 → { [reportHash]: AgentReport }. Members only: the hashes are public
 * on-chain, but a report holds names from death certificates and fee statements.
 */
export const GET = handler(async (req) => {
  rateLimit(req, "reports", 60);
  const params = new URL(req.url).searchParams;
  const estate = addr.parse(params.get("estate"));
  const q = params.get("hashes") ?? "";
  const wanted = [...new Set(hashes.parse(q ? q.split(",") : []))].slice(0, REPORTS_MAX);
  await requireMember(req, estate);
  return json(await getReports(wanted, estate));
});
