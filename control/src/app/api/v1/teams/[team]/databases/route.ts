import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { queues } from "@/lib/queues";
import { ENGINES } from "@/lib/runtime/db-engines";
import { allocatePublicPort, newDatabaseData } from "@/lib/runtime/databases";
import { createDbSchema, databaseDTO } from "@/lib/runtime/database-api";

export const dynamic = "force-dynamic";

/** GET /api/v1/teams/:team/databases → { items } */
export const GET = route<{ team: string }>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team } = await requireTeamRole(t, "VIEWER", { scope: "projects:read" });
  const rows = await db.database.findMany({
    where: { teamId: team.id },
    include: { project: { select: { id: true, slug: true, name: true } }, backups: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { createdAt: "asc" },
  });
  return json({ items: rows.map(databaseDTO) });
});

/** POST /api/v1/teams/:team/databases { name, engine, version?, projectId?, publicAccess?, backupSchedule?, backupRetention? } → 201 */
export const POST = route<{ team: string }>(async (req, { params }) => {
  const { team: t } = await params;
  const input = await body(req, createDbSchema);
  const { team, actor } = await requireTeamRole(t, "ADMIN", { scope: "projects:write" });
  if (input.version && !ENGINES[input.engine].versions.includes(input.version)) throw E.validation({ version: `Supported: ${ENGINES[input.engine].versions.join(", ")}` });
  if (input.projectId && !(await db.project.findFirst({ where: { id: input.projectId, teamId: team.id } }))) throw E.validation({ projectId: "Unknown project" });
  if (await db.database.findUnique({ where: { teamId_name: { teamId: team.id, name: input.name } } })) throw E.conflict(`A database named "${input.name}" already exists`);
  if ((await db.database.count({ where: { teamId: team.id } })) >= 50) throw E.conflict("A team can have at most 50 databases");
  const data = newDatabaseData({ teamId: team.id, projectId: input.projectId, name: input.name, engine: input.engine, version: input.version });
  const row = await db.database.create({
    data: {
      ...data,
      publicPort: input.publicAccess ? await allocatePublicPort(input.engine) : null,
      backupSchedule: input.backupSchedule || null,
      backupRetention: input.backupRetention,
    },
    include: { project: { select: { id: true, slug: true, name: true } } },
  });
  await db.database.update({ where: { id: row.id }, data: { internalHost: `ld-db-${row.id}`, volumeName: `levant_db_${row.id}` } });
  await queues.backups.add({ databaseId: row.id, action: "provision" }, { jobId: `db-provision-${row.id}` });
  await audit({ action: "database.create", teamId: team.id, actor, targetType: "database", targetId: row.id, meta: { name: row.name, engine: row.engine, projectId: row.projectId } });
  return json({ database: databaseDTO({ ...row, internalHost: `ld-db-${row.id}` }) }, 201);
});
