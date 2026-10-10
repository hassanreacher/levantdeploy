import { z } from "zod";
import { route, json, body, requireProjectRole, throttle, E } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createDeployment } from "@/lib/deployments";
import { toDTO } from "@/lib/dashboard/deployments";

const schema = z.object({
  /** false → build without the layer cache (meta.noCache = true, honoured by the build area) */
  useCache: z.boolean().default(true),
  /** default: same target as the source deployment */
  target: z.enum(["PRODUCTION", "PREVIEW"]).optional(),
});

/**
 * POST /api/v1/deployments/:id/redeploy { useCache?, target? } → 201 { deployment }
 * Creates a NEW deployment from the same source (branch/commit/upload) with sourceDeploymentId = :id.
 */
export const POST = route<{ id: string }>(
  async (req, { params }) => {
    const { id } = await params;
    const input = await body(req, schema);
    const src = await db.deployment.findFirst({ where: { OR: [{ id }, { shortId: id }] } });
    if (!src) throw E.notFound("Deployment not found");
    const { team, actor, project } = await requireProjectRole(src.projectId, "MEMBER", { scope: "deployments:write" });
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    if (project.pausedAt) throw E.conflict("This project is paused. Resume it before deploying.");
    const d = await createDeployment({
      projectId: project.id,
      target: input.target ?? src.target,
      trigger: "REDEPLOY",
      createdById: actor.user.id,
      source: {
        branch: src.branch,
        commitSha: src.commitSha,
        commitMessage: src.commitMessage,
        commitAuthor: src.commitAuthor,
        commitAuthorAvatar: src.commitAuthorAvatar,
        prNumber: src.prNumber,
        uploadId: src.uploadId,
        sourceDeploymentId: src.id,
      },
      meta: { redeployOf: src.id, redeployOfNumber: src.number, noCache: !input.useCache },
    });
    await audit({ action: "deployment.redeploy", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { from: src.id, number: d.number, useCache: input.useCache } });
    return json({ deployment: toDTO(d) }, 201);
  },
  { limit: LIMITS.deploy, key: "deploy" },
);
