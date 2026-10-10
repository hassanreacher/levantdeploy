import { z } from "zod";
import { route, json, body, query, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { appUrl } from "@/lib/env";
import { deploymentUrl, hostUrl, projectHost } from "@/lib/deployments";
import { resolveTeam } from "@/lib/git/team";
import { createProjectFromImport, createProjectSchema, ImportError } from "@/lib/git/import";
import { assertCanCreateProject, assertCanDeploy } from "@/lib/plans/enforce";

export const dynamic = "force-dynamic";

const listQuery = z.object({
  team: z.string().max(60).optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/v1/projects?team&q&cursor&limit → { items: [{ id, name, slug, framework, sourceType, repo, productionUrl, latestDeployment }], next } */
export const GET = route(async (req) => {
  const f = query(req, listQuery);
  const { team } = await resolveTeam(f.team, "VIEWER", { scope: "projects:read" });
  const rows = await db.project.findMany({
    where: { teamId: team.id, ...(f.q ? { OR: [{ name: { contains: f.q, mode: "insensitive" } }, { slug: { contains: f.q.toLowerCase() } }] } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    include: {
      deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, number: true, status: true, target: true, url: true, branch: true, commitSha: true, createdAt: true } },
    },
  });
  const more = rows.length > f.limit;
  const items = rows.slice(0, f.limit).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    framework: p.framework,
    sourceType: p.sourceType,
    kind: p.kind,
    repo: p.githubRepoFullName ?? p.gitUrl ?? null,
    productionBranch: p.productionBranch,
    productionUrl: hostUrl(projectHost(p.slug)),
    dashboardUrl: appUrl(`/${team.slug}/${p.slug}`),
    updatedAt: p.updatedAt,
    latestDeployment: p.deployments[0] ? { ...p.deployments[0], url: deploymentUrl(p.deployments[0]) } : null,
  }));
  return json({ team: { id: team.id, slug: team.slug, name: team.name }, items, next: more ? items[items.length - 1]!.id : null });
});

/**
 * POST /api/v1/projects — create (import) a project and (by default) its first production deployment.
 * Body: { team?, name, framework?, rootDirectory?, productionBranch?, buildSettings?, port?, kind?, env?: [{key,value,targets?,isSecret?}],
 *         source: {type:"github", installationId, repoId|repoFullName} | {type:"git", url, token?, tokenUsername?, deployKeyId?, polling?}
 *               | {type:"upload", uploadId} | {type:"image", image} | {type:"template", template} | {type:"none"},
 *         deploy?: true }
 * → 201 { project: {id, slug, name}, deployment: {id, number, url} | null, urls: { dashboard, deployment, production } }
 */
export const POST = route(
  async (req) => {
    const input = await body(req, createProjectSchema);
    const access = await resolveTeam(input.team, "MEMBER", { scope: "projects:write" });
    await throttle(`project-create:${access.user.id}`, { limit: 30, window: 3600 });
    // plans area: project count + email verification (402 PLAN_LIMIT / 403 EMAIL_UNVERIFIED); first deployment checked up front
    await assertCanCreateProject(access.team.id, "deploy", { userId: access.user.id });
    if (input.deploy !== false && input.source.type !== "none") await assertCanDeploy(access.team.id, { userId: access.user.id });
    try {
      const { project, deployment } = await createProjectFromImport(
        { ...input, trigger: input.trigger === "MANUAL" && access.actor.kind === "token" ? "CLI" : input.trigger },
        { team: access.team, userId: access.user.id },
      );
      await audit({ action: "project.create", teamId: access.team.id, actor: access.actor, targetType: "project", targetId: project.id, meta: { name: project.name, source: input.source.type } });
      if (deployment) await audit({ action: "deployment.create", teamId: access.team.id, actor: access.actor, targetType: "deployment", targetId: deployment.id, meta: { number: deployment.number, first: true } });
      return json(
        {
          project: { id: project.id, slug: project.slug, name: project.name, teamSlug: access.team.slug, sourceType: project.sourceType },
          deployment: deployment ? { id: deployment.id, number: deployment.number, url: deployment.url, status: deployment.status } : null,
          urls: {
            dashboard: appUrl(`/${access.team.slug}/${project.slug}`),
            deployment: deployment ? appUrl(`/${access.team.slug}/${project.slug}/deployments/${deployment.id}`) : null,
            production: hostUrl(projectHost(project.slug)),
          },
        },
        201,
      );
    } catch (e) {
      if (e instanceof ImportError) {
        if (e.status === 409) throw E.conflict(e.message);
        if (e.status === 404) throw E.notFound(e.message);
        if (e.fields) throw E.validation(e.fields, e.message);
        throw E.bad(e.message);
      }
      throw e;
    }
  },
  { key: "project-create", limit: { limit: 30, window: 60 } },
);
