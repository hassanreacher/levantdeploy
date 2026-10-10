import { route, json, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { findDeployment, enqueueAction } from "@/lib/runtime/api";

/** POST /api/v1/deployments/:id/restart → 202 { jobId }  (rolling restart; starts it when stopped) */
export const POST = route<{ id: string }>(
  async (_req, { params }) => {
    const { id } = await params;
    const d = await findDeployment(id);
    const { team, actor } = await requireProjectRole(d.projectId, "MEMBER", { scope: "deployments:write" });
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    if (!["READY", "SUPERSEDED"].includes(d.status)) throw E.conflict(`Can't restart a ${d.status.toLowerCase()} deployment`);
    const jobId = await enqueueAction(d.id, d.stoppedAt ? "start" : "restart", { byUserId: actor.user.id });
    await audit({ action: d.stoppedAt ? "deployment.start" : "deployment.restart", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number } });
    return json({ deployment: { id: d.id, number: d.number }, jobId, action: d.stoppedAt ? "start" : "restart" }, 202);
  },
  { limit: LIMITS.deploy, key: "deploy" },
);
