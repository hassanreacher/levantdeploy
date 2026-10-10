import { route, json, requireProjectRole } from "@/lib/http";
import { db } from "@/lib/db";
import { databaseDTO, ENGINE_OPTIONS } from "@/lib/runtime/database-api";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id/databases → { items (connected), available (team, not connected), engines } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "projects:read" });
  const include = { project: { select: { id: true, slug: true, name: true } }, backups: { orderBy: { createdAt: "desc" as const }, take: 1 } };
  const [items, available] = await Promise.all([
    db.database.findMany({ where: { projectId: project.id }, include, orderBy: { createdAt: "asc" } }),
    db.database.findMany({ where: { teamId: project.teamId, OR: [{ projectId: null }, { projectId: { not: project.id } }] }, include, orderBy: { createdAt: "asc" } }),
  ]);
  return json({ items: items.map(databaseDTO), available: available.map(databaseDTO), engines: ENGINE_OPTIONS });
});
