import fs from "node:fs";
import { Readable } from "node:stream";
import { route, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { backupFilePath } from "@/lib/runtime/databases";
import { requireDatabase } from "@/lib/runtime/api";

export const dynamic = "force-dynamic";

/** GET /api/v1/databases/:id/backups/:backupId/download → the dump file (ADMIN, audited) */
export const GET = route<{ id: string; backupId: string }>(async (_req, { params }) => {
  const { id, backupId } = await params;
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  const b = await db.backup.findFirst({ where: { id: backupId, databaseId: id } });
  const file = b ? backupFilePath(b) : null;
  if (!b || !file || !fs.existsSync(file)) throw E.notFound("Backup file not found");
  await audit({ action: "database.backup_download", teamId: team.id, actor, targetType: "database", targetId: id, meta: { backupId } });
  const stat = fs.statSync(file);
  const name = `${database.name}-${file.split("/").pop()}`;
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: { "content-type": "application/octet-stream", "content-length": String(stat.size), "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
});
