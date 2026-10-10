import { z } from "zod";
import { route, json, query, requirePlatformOwner } from "@/lib/http";
import { teamsOverview } from "@/lib/plans/admin";

export const dynamic = "force-dynamic";

/** GET /api/v1/platform/plans/teams?overQuota=1 → { items: [{ id, slug, name, plan, source, counts, overQuota[], nearQuota }] } */
export const GET = route(async (req) => {
  await requirePlatformOwner();
  const q = query(req, z.object({ overQuota: z.enum(["0", "1", "true", "false"]).optional() }));
  return json({ items: await teamsOverview({ overQuotaOnly: q.overQuota === "1" || q.overQuota === "true" }) });
});
