import { z } from "zod";
import { route, json, body, requireProjectRole, throttle, E } from "@/lib/http";
import { audit } from "@/lib/audit";
import { LIMITS } from "@/lib/rate-limit";
import { deployBranch, TriggerError } from "@/lib/git/trigger";

export const dynamic = "force-dynamic";

/** POST /api/v1/projects/:id/git/deploy { branch? } — deploy the head of a branch now (production branch → PRODUCTION). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ branch: z.string().trim().max(250).optional() }));
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "deployments:write" });
  await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
  try {
    const d = await deployBranch(project.id, input.branch ?? null, { trigger: "MANUAL", createdById: actor.user.id });
    await audit({ action: "deployment.create", teamId: team.id, actor, targetType: "deployment", targetId: d!.id, meta: { branch: d!.branch } });
    return json({ deployment: d }, 201);
  } catch (e) {
    if (e instanceof TriggerError) throw e.status === 404 ? E.notFound(e.message) : E.bad(e.message);
    throw e;
  }
});
