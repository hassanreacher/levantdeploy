import { z } from "zod";
import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

/** POST /api/v1/projects/:id/env-groups { groupId } — link a team shared env group (MEMBER) */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const { groupId } = await body(req, z.object({ groupId: z.string().min(1).max(64) }));
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "env:write" });
  const group = await db.sharedEnvGroup.findFirst({ where: { id: groupId, teamId: team.id } });
  if (!group) throw E.notFound("Shared env group not found");
  await db.projectSharedEnvGroup.upsert({ where: { projectId_groupId: { projectId: project.id, groupId } }, create: { projectId: project.id, groupId }, update: {} });
  await audit({ action: "env.group_link", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { group: group.name } });
  return json({ ok: true }, 201);
});
