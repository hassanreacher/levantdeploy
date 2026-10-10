import { z } from "zod";
import { route, json, body, requireProjectRole, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertCanCreateProject } from "@/lib/plans/enforce";

const schema = z.object({ team: z.string().min(1).max(64) });

/**
 * POST /api/v1/projects/:id/transfer { team: <id|slug> } — ADMIN in both teams.
 * Moves the project and its project-scoped resources (databases, notification channels, webhooks, AI conversations).
 * Shared env group links are removed (groups are team-scoped).
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const from = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  const to = await requireTeamRole(input.team, "ADMIN", { actor: from.actor });
  if (to.team.id === from.team.id) throw E.bad("The project already belongs to this team");
  const clash = await db.project.findUnique({ where: { teamId_slug: { teamId: to.team.id, slug: from.project.slug } }, select: { id: true } });
  if (clash) throw E.conflict(`Team ${to.team.name} already has a project named "${from.project.slug}". Rename it first.`);
  await assertCanCreateProject(to.team.id, "deploy"); // plans area: the target team's project limit
  const pid = from.project.id;
  await db.$transaction([
    db.projectSharedEnvGroup.deleteMany({ where: { projectId: pid } }),
    db.database.updateMany({ where: { projectId: pid }, data: { teamId: to.team.id } }),
    db.notification.updateMany({ where: { projectId: pid }, data: { teamId: to.team.id } }),
    db.webhook.updateMany({ where: { projectId: pid }, data: { teamId: to.team.id } }),
    db.agentConversation.updateMany({ where: { projectId: pid }, data: { teamId: to.team.id } }),
    db.baseProject.updateMany({ where: { projectId: pid }, data: { teamId: to.team.id } }), // base-dashboard: the backend moves with its project
    db.project.update({ where: { id: pid }, data: { teamId: to.team.id } }),
  ]);
  const meta = { name: from.project.name, from: from.team.slug, to: to.team.slug };
  await audit({ action: "project.transfer", teamId: from.team.id, actor: from.actor, targetType: "project", targetId: pid, meta });
  await audit({ action: "project.transfer", teamId: to.team.id, actor: from.actor, targetType: "project", targetId: pid, meta });
  return json({ ok: true, team: { slug: to.team.slug }, project: { slug: from.project.slug } });
});
