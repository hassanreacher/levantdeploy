import { z } from "zod";
import { route, json, query } from "@/lib/http";
import { db } from "@/lib/db";
import { requireBaseRole } from "@/lib/base-ui/access";
import { eventDTO } from "@/lib/base-ui/dto";
import { baseEventsResponse } from "@/lib/base-ui/events";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/base/projects/:ref/events — SSE (`event: status`, `event: event`), or `?format=json&limit=` for a page.
 */
export const GET = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const q = query(req, z.object({ format: z.enum(["sse", "json"]).default("sse"), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const { base } = await requireBaseRole(ref, "VIEWER");
  if (q.format === "json") {
    const rows = await db.baseEvent.findMany({ where: { baseProjectId: base.id }, orderBy: { createdAt: "desc" }, take: q.limit });
    return json({ status: base.status, items: rows.map(eventDTO) });
  }
  return baseEventsResponse(base.id, { signal: req.signal });
});
