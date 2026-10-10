import { z } from "zod";
import { route, json, body, requireProjectRole } from "@/lib/http";
import { audit } from "@/lib/audit";
import { createDeployHook, listDeployHooks } from "@/lib/git/deploy-hooks";
import { TriggerError } from "@/lib/git/trigger";
import { E } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id/git/hooks → { items: [{ id, name, branch, url, createdAt, lastTriggeredAt }] } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "MEMBER", { scope: "projects:read" });
  return json({ items: await listDeployHooks(project.id) });
});

/** POST /api/v1/projects/:id/git/hooks { name, branch } → 201 { hook } */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ name: z.string().trim().min(1).max(60), branch: z.string().trim().min(1).max(250) }));
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "projects:write" });
  if (project.sourceType !== "GITHUB" && project.sourceType !== "GIT") throw E.bad("Deploy hooks need a connected Git repository");
  try {
    const hook = await createDeployHook(project.id, input);
    await audit({ action: "project.deploy_hook_create", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { name: input.name, branch: input.branch } });
    return json({ hook }, 201);
  } catch (e) {
    if (e instanceof TriggerError) throw E.bad(e.message);
    throw e;
  }
});
