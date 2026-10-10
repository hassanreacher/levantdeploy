import { route, json, requireProjectRole } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

/** DELETE /api/v1/projects/:id/env-groups/:groupId — unlink (MEMBER) */
export const DELETE = route<{ id: string; groupId: string }>(async (_req, { params }) => {
  const { id, groupId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "env:write" });
  await db.projectSharedEnvGroup.deleteMany({ where: { projectId: project.id, groupId } });
  await audit({ action: "env.group_unlink", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { groupId } });
  return json({ ok: true });
});
