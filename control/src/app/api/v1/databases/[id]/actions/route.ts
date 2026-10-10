import { z } from "zod";
import { route, json, body, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queues } from "@/lib/queues";
import { requireDatabase } from "@/lib/runtime/api";

const schema = z.object({ action: z.enum(["start", "stop", "restart"]) });

/** POST /api/v1/databases/:id/actions { action: start|stop|restart } → 202 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const { action } = await body(req, schema);
  const { database, team, actor } = await requireDatabase(id, "ADMIN", "projects:write");
  if (database.status === "DELETING") throw E.conflict("Database is being deleted");
  if (action === "start" || action === "restart") await db.database.update({ where: { id }, data: { status: "PROVISIONING" } });
  await queues.backups.add({ databaseId: id, action }, { jobId: `db-${action}-${id}-${Date.now()}` });
  await audit({ action: `database.${action}`, teamId: team.id, actor, targetType: "database", targetId: id, meta: { name: database.name } });
  return json({ ok: true }, 202);
});
