import { json, throttle } from "@/lib/http";
import { LIMITS } from "@/lib/rate-limit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { publishBuilderProject, publishState } from "@/lib/builder/publish";

export const dynamic = "force-dynamic";

/** GET …/publish → { project, deployment, url, lastPublishedAt, lastPublishedCommit } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireBuilder(id, "VIEWER");
  return json(await publishState(id));
});

/**
 * POST …/publish → 201 { deployment, url, productionUrl, project, createdProject, commit, envKeys, …publishState }
 * HEAD → production deployment of the linked Deploy project (created on first publish). MEMBER.
 * Follow progress with GET /api/v1/deployments/:id and the deployment log SSE.
 */
export const POST = builderRoute<{ id: string }>(
  async (_req, { params }) => {
    const { id } = await params;
    const { actor } = await requireBuilder(id, "MEMBER", "projects:write");
    await throttle(`deploy:${actor.user.id}`, LIMITS.deploy);
    const r = await publishBuilderProject(id, actor);
    const st = await publishState(id);
    return json({ ...st, ...r, deployment: { ...st.deployment, ...r.deployment } }, 201);
  },
  { key: "deploy" },
);
