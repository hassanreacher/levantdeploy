import { route, json, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { findDeployment, enqueueAction } from "@/lib/runtime/api";

/**
 * POST /api/v1/deployments/:id/rollback → 202 { deployment, jobId }
 * Makes this previous production deployment current again (start its stopped containers or recreate them from its
 * image → health → switch routes). The replaced production deployment is stopped after the drain period.
 */
export const POST = route<{ id: string }>(
  async (_req, { params }) => {
    const { id } = await params;
    const d = await findDeployment(id);
    const { team, actor } = await requireProjectRole(d.projectId, "MEMBER", { scope: "deployments:write" });
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    if (d.target !== "PRODUCTION") throw E.conflict("Only production deployments can be rolled back to — promote a preview instead");
    if (!["READY", "SUPERSEDED"].includes(d.status) || !d.imageTag) throw E.conflict(`Can't roll back to a ${d.status.toLowerCase()} deployment`);
    if (d.isCurrentProduction && !d.stoppedAt) throw E.conflict("This deployment is already the current production deployment");
    const jobId = await enqueueAction(d.id, "rollback", { byUserId: actor.user.id });
    await audit({ action: "deployment.rollback", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number } });
    return json({ deployment: { id: d.id, number: d.number, url: d.url }, jobId }, 202);
  },
  { limit: LIMITS.deploy, key: "deploy" },
);
