import { z } from "zod";
import { route, json, query, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id/cron/:cronId/runs?limit= → { items: CronRun[] } (output included) */
export const GET = route<{ id: string; cronId: string }>(async (req, { params }) => {
  const { id, cronId } = await params;
  const { limit } = query(req, z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }));
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "logs:read" });
  const j = await db.cronJob.findFirst({ where: { id: cronId, projectId: project.id }, select: { id: true } });
  if (!j) throw E.notFound("Cron job not found");
  const items = await db.cronRun.findMany({ where: { cronJobId: j.id }, orderBy: { startedAt: "desc" }, take: limit });
  return json({ items });
});
