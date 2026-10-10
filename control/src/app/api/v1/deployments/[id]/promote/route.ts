import { route, json, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { createDeployment, setStatus } from "@/lib/deployments";
import { queues } from "@/lib/queues";
import { findDeployment, enqueueAction } from "@/lib/runtime/api";

/**
 * POST /api/v1/deployments/:id/promote → 202 { deployment, jobId }
 *  - PREVIEW: new PRODUCTION deployment (trigger PROMOTE) from the same image, production env → deploy
 *  - PRODUCTION (not current): instant rollback to it
 */
export const POST = route<{ id: string }>(
  async (_req, { params }) => {
    const { id } = await params;
    const d = await findDeployment(id);
    const { team, actor, project } = await requireProjectRole(d.projectId, "MEMBER", { scope: "deployments:write" });
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    if (project.pausedAt) throw E.conflict("This project is paused. Resume it before deploying.");
    if (!["READY", "SUPERSEDED"].includes(d.status) || !d.imageTag) throw E.conflict(`Only ready deployments can be promoted (this one is ${d.status.toLowerCase()})`);
    if (d.target === "PRODUCTION") {
      if (d.isCurrentProduction && !d.stoppedAt) throw E.conflict("This deployment is already the current production deployment");
      const jobId = await enqueueAction(d.id, "rollback", { byUserId: actor.user.id });
      await audit({ action: "deployment.promote", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number, instant: true } });
      return json({ deployment: { id: d.id, number: d.number, url: d.url }, jobId }, 202);
    }
    const nd = await createDeployment({
      projectId: project.id,
      target: "PRODUCTION",
      trigger: "PROMOTE",
      createdById: actor.user.id,
      enqueue: false,
      source: {
        branch: d.branch,
        commitSha: d.commitSha,
        commitMessage: d.commitMessage,
        commitAuthor: d.commitAuthor,
        commitAuthorAvatar: d.commitAuthorAvatar,
        prNumber: d.prNumber,
        uploadId: d.uploadId,
        sourceDeploymentId: d.id,
      },
      meta: { promotedFrom: d.id, promotedFromNumber: d.number, ...(d.meta && typeof d.meta === "object" && "build" in (d.meta as object) ? { build: (d.meta as { build: never }).build } : {}) },
    });
    await setStatus(nd.id, "DEPLOYING", { imageTag: d.imageTag, message: `Promoted from preview #${d.number}` });
    const job = await queues.deploy.add({ deploymentId: nd.id });
    await audit({ action: "deployment.promote", teamId: team.id, actor, targetType: "deployment", targetId: nd.id, meta: { from: d.id, fromNumber: d.number, number: nd.number } });
    return json({ deployment: { id: nd.id, number: nd.number, url: nd.url }, jobId: job.id }, 202);
  },
  { limit: LIMITS.deploy, key: "deploy" },
);
