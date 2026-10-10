import { route, json, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { createdBySelect, toDTO } from "@/lib/dashboard/deployments";
import { projectHost, branchHost } from "@/lib/deployments";

export const dynamic = "force-dynamic";

/** GET /api/v1/deployments/:id (id or shortId) → { deployment, events, aliases, project } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const d = await db.deployment.findFirst({ where: { OR: [{ id }, { shortId: id }] }, include: { createdBy: createdBySelect } });
  if (!d) throw E.notFound("Deployment not found");
  const { project } = await requireProjectRole(d.projectId, "VIEWER", { scope: "deployments:read" });
  const events = await db.deploymentEvent.findMany({ where: { deploymentId: d.id }, orderBy: { createdAt: "asc" } });
  const aliases: string[] = [];
  if (d.isCurrentProduction) {
    aliases.push(projectHost(project.slug));
    const domains = await db.domain.findMany({ where: { projectId: project.id, gitBranch: null, status: { in: ["ACTIVE", "PENDING", "VERIFYING"] } }, select: { hostname: true } });
    aliases.push(...domains.map((x) => x.hostname));
  } else if (d.target === "PREVIEW" && d.branch && d.status === "READY") {
    const newer = await db.deployment.findFirst({ where: { projectId: project.id, branch: d.branch, status: "READY", target: "PREVIEW", createdAt: { gt: d.createdAt } }, select: { id: true } });
    if (!newer) aliases.push(branchHost(project.slug, d.branch));
  }
  return json({
    deployment: toDTO(d),
    events: events.map((e) => ({ id: e.id, status: e.status, fromStatus: e.fromStatus, message: e.message, createdAt: e.createdAt.toISOString() })),
    aliases: [...new Set(aliases)],
    project: { id: project.id, slug: project.slug, name: project.name },
  });
});
