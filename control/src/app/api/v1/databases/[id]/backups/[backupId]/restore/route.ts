import { route, json, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queues } from "@/lib/queues";
import { requireDatabase } from "@/lib/runtime/api";

/** POST /api/v1/databases/:id/backups/:backupId/restore → 202 (overwrites the current data) */
export const POST = route<{ id: string; backupId: string }>(async (_req, { params }) => {
  const { id, backupId } = await params;
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  const b = await db.backup.findFirst({ where: { id: backupId, databaseId: id } });
  if (!b || b.status !== "SUCCESS" || !b.path) throw E.notFound("Backup not found or not restorable");
  if (database.status !== "RUNNING") throw E.conflict("The database must be running to restore");
  const job = await queues.backups.add({ backupId: b.id, databaseId: id, action: "restore" }, { jobId: `restore-${b.id}-${Date.now()}` });
  await audit({ action: "database.restore", teamId: team.id, actor, targetType: "database", targetId: id, meta: { backupId } });
  return json({ ok: true, jobId: job.id }, 202);
});
