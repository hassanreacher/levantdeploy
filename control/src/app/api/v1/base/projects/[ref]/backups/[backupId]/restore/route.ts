import { z } from "zod";
import { route, json, body, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { restoreBackup } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";

/** POST /api/v1/base/projects/:ref/backups/:backupId/restore { confirm: <project name> } — ADMIN. Overwrites the database. */
export const POST = route<{ ref: string; backupId: string }>(async (req, { params }) => {
  const { ref, backupId } = await params;
  const { confirm } = await body(req, z.object({ confirm: z.string().max(200) }));
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  if (confirm.trim() !== base.name && confirm.trim() !== base.ref) throw E.validation({ confirm: `Type "${base.name}" to confirm` });
  const b = await db.baseBackup.findFirst({ where: { id: backupId, baseProjectId: base.id } });
  if (!b) throw E.notFound("Backup not found");
  if (b.status !== "SUCCEEDED") throw E.conflict("Only finished backups can be restored");
  if (base.status !== "ACTIVE") throw E.conflict("The project must be running to restore a backup");
  await restoreBackup(ref, backupId, actor.user.id);
  await audit({ action: "base.backup.restore", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, backupId, backupAt: b.createdAt.toISOString() } });
  return json({ ok: true });
});
