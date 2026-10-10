import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createEnv, envCreateSchema } from "@/lib/dashboard/env-api";

/** POST /api/v1/teams/:team/env-groups/:groupId/vars — same body as project env POST (no branch) (ADMIN) */
export const POST = route<{ team: string; groupId: string }>(async (req, { params }) => {
  const { team, groupId } = await params;
  const input = await body(req, envCreateSchema);
  const { team: t, actor } = await requireTeamRole(team, "ADMIN", { scope: "env:write" });
  const group = await db.sharedEnvGroup.findFirst({ where: { id: groupId, teamId: t.id } });
  if (!group) throw E.notFound("Shared env group not found");
  const res = await createEnv({ groupId: group.id }, input, actor.user.id);
  await db.sharedEnvGroup.update({ where: { id: group.id }, data: { updatedAt: new Date() } });
  await audit({ action: "env_group.vars", teamId: t.id, actor, targetType: "env_group", targetId: group.id, meta: { keys: res.keys.slice(0, 50) } });
  return json(res, 201);
});
