import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { envPatchSchema, updateEnv, viewEnv } from "@/lib/dashboard/env-api";

async function load(team: string, groupId: string) {
  const access = await requireTeamRole(team, "ADMIN", { scope: "env:write" });
  const group = await db.sharedEnvGroup.findFirst({ where: { id: groupId, teamId: access.team.id } });
  if (!group) throw E.notFound("Shared env group not found");
  return { ...access, group };
}

export const PATCH = route<{ team: string; groupId: string; varId: string }>(async (req, { params }) => {
  const { team, groupId, varId } = await params;
  const input = await body(req, envPatchSchema);
  const { group, team: t, actor, role } = await load(team, groupId);
  const row = await updateEnv({ groupId: group.id }, varId, input);
  await audit({ action: "env_group.var_update", teamId: t.id, actor, targetType: "env_group", targetId: group.id, meta: { key: row.key } });
  return json({ item: viewEnv(row, role) });
});

export const DELETE = route<{ team: string; groupId: string; varId: string }>(async (_req, { params }) => {
  const { team, groupId, varId } = await params;
  const { group, team: t, actor } = await load(team, groupId);
  const row = await db.envVar.findFirst({ where: { id: varId, groupId: group.id } });
  if (!row) throw E.notFound("Variable not found");
  await db.envVar.delete({ where: { id: row.id } });
  await audit({ action: "env_group.var_delete", teamId: t.id, actor, targetType: "env_group", targetId: group.id, meta: { key: row.key } });
  return json({ ok: true });
});
