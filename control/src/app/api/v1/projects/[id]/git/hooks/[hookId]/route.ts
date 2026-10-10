import { route, json, requireProjectRole, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { deleteDeployHook } from "@/lib/git/deploy-hooks";

export const dynamic = "force-dynamic";

/** DELETE /api/v1/projects/:id/git/hooks/:hookId */
export const DELETE = route<{ id: string; hookId: string }>(async (_req, { params }) => {
  const { id, hookId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  if (!(await deleteDeployHook(project.id, hookId))) throw E.notFound("Deploy hook not found");
  await audit({ action: "project.deploy_hook_delete", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { hookId } });
  return json({ ok: true });
});
