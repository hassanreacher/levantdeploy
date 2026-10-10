import { route, json, E } from "@/lib/http";
import { appUrl } from "@/lib/env";
import { db } from "@/lib/db";
import { deploymentUrl } from "@/lib/deployments";
import { triggerDeployHook } from "@/lib/git/deploy-hooks";
import { TriggerError } from "@/lib/git/trigger";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/deploy-hooks/:projectId/:token — unauthenticated deploy hook (the URL is the secret).
 * → 201 { job: { deploymentId, url, state: "QUEUED" } }
 */
export const POST = route<{ projectId: string; token: string }>(
  async (_req, { params }) => {
    const { projectId, token } = await params;
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw E.notFound();
    try {
      const { deployment } = await triggerDeployHook(projectId, token);
      const p = await db.project.findUnique({ where: { id: projectId }, select: { slug: true, team: { select: { slug: true } } } });
      return json(
        {
          job: {
            deploymentId: deployment?.id ?? null,
            url: deployment ? deploymentUrl(deployment) : null,
            state: deployment?.status ?? "QUEUED",
            inspect: deployment && p ? appUrl(`/${p.team.slug}/${p.slug}/deployments/${deployment.id}`) : null,
          },
        },
        201,
      );
    } catch (e) {
      if (e instanceof TriggerError) throw e.status === 404 ? E.notFound() : e.status === 409 ? E.conflict(e.message) : E.bad(e.message);
      throw e;
    }
  },
  { limit: { limit: 30, window: 60 }, key: "deploy-hook" },
);
