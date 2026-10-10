import fs from "node:fs/promises";
import { route, json, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { backupFilePath } from "@/lib/runtime/databases";
import { requireDatabase } from "@/lib/runtime/api";

/** DELETE /api/v1/databases/:id/backups/:backupId */
export const DELETE = route<{ id: string; backupId: string }>(async (_req, { params }) => {
  const { id, backupId } = await params;
  const { team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  const b = await db.backup.findFirst({ where: { id: backupId, databaseId: id } });
  if (!b) throw E.notFound("Backup not found");
  if (b.status === "RUNNING") throw E.conflict("Backup is still running");
  const file = backupFilePath(b);
  if (file) await fs.rm(file, { force: true });
  await db.backup.delete({ where: { id: b.id } });
  await audit({ action: "database.backup_delete", teamId: team.id, actor, targetType: "database", targetId: id, meta: { backupId } });
  return json({ ok: true });
});
