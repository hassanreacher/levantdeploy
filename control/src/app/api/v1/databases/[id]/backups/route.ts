import { route, json, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queues } from "@/lib/queues";
import { backupDTO } from "@/lib/runtime/database-api";
import { requireDatabase } from "@/lib/runtime/api";

export const dynamic = "force-dynamic";

/** GET /api/v1/databases/:id/backups → { items } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireDatabase(id, "VIEWER", "projects:read");
  const items = await db.backup.findMany({ where: { databaseId: id }, orderBy: { createdAt: "desc" }, take: 100 });
  return json({ items: items.map(backupDTO) });
});

/** POST /api/v1/databases/:id/backups → 202 { backup } (manual backup) */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  await throttle(`db-backup:${id}`, { limit: 5, window: 300 });
  if (database.status !== "RUNNING") throw E.conflict("The database must be running to back it up");
  const b = await db.backup.create({ data: { databaseId: id, trigger: "MANUAL", status: "PENDING" } });
  await queues.backups.add({ backupId: b.id, action: "backup" }, { jobId: `backup-${b.id}` });
  await audit({ action: "database.backup", teamId: team.id, actor, targetType: "database", targetId: id, meta: { backupId: b.id } });
  return json({ backup: backupDTO(b) }, 202);
});
