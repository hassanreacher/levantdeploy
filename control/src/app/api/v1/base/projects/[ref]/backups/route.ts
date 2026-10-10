import { route, json, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createBackup } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { backupDTO } from "@/lib/base-ui/dto";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/backups — MEMBER. */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base } = await requireBaseRole(ref, "MEMBER", { scope: "base:read" });
  const rows = await db.baseBackup.findMany({ where: { baseProjectId: base.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  return json({ items: rows.map((r) => backupDTO({ ...r, createdBy: r.createdById ? (name.get(r.createdById) ?? null) : null })) });
});

/** POST /api/v1/base/projects/:ref/backups — ADMIN: manual pg_dump. */
export const POST = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base, team, actor } = await requireBaseRole(ref, "ADMIN");
  await throttle(`base:backup:${actor.user.id}`, { limit: 6, window: 600 });
  if (base.status !== "ACTIVE") throw E.conflict("The project must be running to take a backup");
  if (await db.baseBackup.findFirst({ where: { baseProjectId: base.id, status: "RUNNING" }, select: { id: true } })) throw E.conflict("A backup is already running");
  const b = await createBackup(ref, actor.user.id);
  await audit({ action: "base.backup.create", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, backupId: b.id } });
  return json({ backup: backupDTO(b) }, 201);
});
