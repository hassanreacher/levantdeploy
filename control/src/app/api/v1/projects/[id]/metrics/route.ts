import { z } from "zod";
import { route, json, query, requireProjectRole } from "@/lib/http";
import { querySeries, RANGES, type RangeKey } from "@/lib/runtime/metrics";

export const dynamic = "force-dynamic";

const q = z.object({ range: z.enum(Object.keys(RANGES) as [RangeKey, ...RangeKey[]]).default("1h"), deploymentId: z.string().max(40).optional() });

/** GET /api/v1/projects/:id/metrics?range=1h|6h|24h|7d[&deploymentId=] → { from, to, step, points[], totals } */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const { range, deploymentId } = query(req, q);
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  return json(await querySeries(project.id, range, deploymentId));
});
