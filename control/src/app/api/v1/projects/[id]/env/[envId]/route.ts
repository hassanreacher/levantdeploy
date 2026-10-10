import { route, json, body, requireProjectRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { envPatchSchema, updateEnv, viewEnv } from "@/lib/dashboard/env-api";

/** PATCH /api/v1/projects/:id/env/:envId { key?, value?, targets?, isSecret?, branch?, comment? } (MEMBER) → { item } */
export const PATCH = route<{ id: string; envId: string }>(async (req, { params }) => {
  const { id, envId } = await params;
  const input = await body(req, envPatchSchema);
  const { project, team, actor, role } = await requireProjectRole(id, "MEMBER", { scope: "env:write" });
  await throttle(`env:${actor.user.id}`);
  const row = await updateEnv({ projectId: project.id }, envId, input);
  await audit({ action: "env.update", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { key: row.key, envId: row.id, fields: Object.keys(input).filter((k) => k !== "value") } });
  return json({ item: viewEnv(row, role) });
});

/** DELETE /api/v1/projects/:id/env/:envId (MEMBER) */
export const DELETE = route<{ id: string; envId: string }>(async (_req, { params }) => {
  const { id, envId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "env:write" });
  const row = await db.envVar.findFirst({ where: { id: envId, projectId: project.id } });
  if (!row) throw E.notFound("Environment variable not found");
  await db.envVar.delete({ where: { id: row.id } });
  await audit({ action: "env.delete", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { key: row.key, envId: row.id } });
  return json({ ok: true });
});
