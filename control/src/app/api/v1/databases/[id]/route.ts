import { route, json, body, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queues } from "@/lib/queues";
import { allocatePublicPort } from "@/lib/runtime/databases";
import { databaseDTO, updateDbSchema } from "@/lib/runtime/database-api";
import { requireDatabase } from "@/lib/runtime/api";

export const dynamic = "force-dynamic";

/** GET /api/v1/databases/:id → { database } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { database } = await requireDatabase(id, "VIEWER", "projects:read");
  const backups = await db.backup.findMany({ where: { databaseId: id }, orderBy: { createdAt: "desc" }, take: 1 });
  return json({ database: databaseDTO({ ...database, backups }) });
});

/**
 * PATCH /api/v1/databases/:id { projectId?, publicAccess?, backupSchedule?, backupRetention? }
 * Connecting/disconnecting a project applies on the project's next deploy (env injection).
 * publicAccess toggles recreate the container (data volume is kept).
 */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, updateDbSchema);
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  if (input.projectId && !(await db.project.findFirst({ where: { id: input.projectId, teamId: team.id } }))) throw E.validation({ projectId: "Unknown project" });
  const data: Record<string, unknown> = {};
  if (input.projectId !== undefined) data.projectId = input.projectId;
  if (input.backupSchedule !== undefined) data.backupSchedule = input.backupSchedule || null;
  if (input.backupRetention !== undefined) data.backupRetention = input.backupRetention;
  let reconfigure = false;
  if (input.publicAccess !== undefined && input.publicAccess !== !!database.publicPort) {
    data.publicPort = input.publicAccess ? await allocatePublicPort(database.engine) : null;
    reconfigure = true;
  }
  const row = await db.database.update({ where: { id }, data, include: { project: { select: { id: true, slug: true, name: true } } } });
  if (reconfigure) await queues.backups.add({ databaseId: id, action: "reconfigure" }, { jobId: `db-reconfigure-${id}-${Date.now()}` });
  await audit({ action: "database.update", teamId: team.id, actor, targetType: "database", targetId: id, meta: input });
  return json({ database: databaseDTO(row), reconfiguring: reconfigure });
});

/** DELETE /api/v1/databases/:id → 202 (container, volume and backups are removed by the worker) */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  await db.database.update({ where: { id }, data: { status: "DELETING", projectId: null } });
  await queues.backups.add({ databaseId: id, action: "delete" }, { jobId: `db-delete-${id}` });
  await audit({ action: "database.delete", teamId: team.id, actor, targetType: "database", targetId: id, meta: { name: database.name, engine: database.engine } });
  return json({ ok: true }, 202);
});
