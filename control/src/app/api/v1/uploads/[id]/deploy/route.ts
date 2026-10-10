import { z } from "zod";
import { route, json, body, requireApiTokenOrSession, requireProjectRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { appUrl } from "@/lib/env";
import { createDeployment, deploymentUrl } from "@/lib/deployments";
import { LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({
  projectId: z.string().max(40).optional(),
  target: z.enum(["PRODUCTION", "PREVIEW"]).default("PREVIEW"),
  /** free-form info shown on the deployment (e.g. git branch/commit of the local folder, CLI version) */
  meta: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
  branch: z.string().max(250).optional().nullable(),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/).optional().nullable(),
  commitMessage: z.string().max(2000).optional().nullable(),
});

/**
 * POST /api/v1/uploads/:id/deploy { projectId?, target, meta?, branch?, commitSha?, commitMessage? }
 *   → 201 { deployment: {id, number, url, status, target}, url, inspectUrl }
 * Creates a deployment from a COMPLETE upload (CLI `levant deploy`, dashboard drag & drop).
 */
export const POST = route<{ id: string }>(
  async (req, { params }) => {
    const { id } = await params;
    const input = await body(req, schema);
    const actor = await requireApiTokenOrSession({ scope: "deployments:write" });
    const up = await db.upload.findUnique({ where: { id } });
    if (!up) throw E.notFound("Upload not found");
    const projectId = input.projectId ?? up.projectId;
    if (!projectId) throw E.validation({ projectId: "Required" });
    const { project, team } = await requireProjectRole(projectId, "MEMBER", { actor });
    if (up.teamId !== team.id) throw E.notFound("Upload not found");
    if (up.status !== "COMPLETE") throw E.conflict("Upload is not complete");
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    if (project.sourceType === "UPLOAD" && !up.projectId) await db.upload.update({ where: { id: up.id }, data: { projectId: project.id } });
    const d = await createDeployment({
      projectId: project.id,
      target: input.target,
      trigger: actor.kind === "token" ? "CLI" : "MANUAL",
      createdById: actor.user.id,
      source: { uploadId: up.id, branch: input.branch ?? null, commitSha: input.commitSha ?? null, commitMessage: input.commitMessage ?? null, commitAuthor: actor.user.name },
      meta: { source: "upload", ...(input.meta ?? {}) },
    });
    await audit({ action: "deployment.create", teamId: team.id, actor, targetType: "deployment", targetId: d.id, meta: { number: d.number, target: d.target, source: "upload" } });
    return json(
      {
        deployment: { id: d.id, number: d.number, url: d.url, status: d.status, target: d.target, projectId: project.id },
        url: deploymentUrl(d),
        inspectUrl: appUrl(`/${team.slug}/${project.slug}/deployments/${d.id}`),
      },
      201,
    );
  },
  { key: "deploy" },
);
