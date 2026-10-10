import { route, json, requireProjectRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { checkDomain } from "@/lib/domains/verify";
import { domainDTO } from "@/lib/domains/service";

/** POST /api/v1/projects/:id/domains/:domainId/verify → { domain } ("Verify now": runs the DNS check synchronously) */
export const POST = route<{ id: string; domainId: string }>(async (_req, { params }) => {
  const { id, domainId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "domains:write" });
  await throttle(`domain-verify:${domainId}`, { limit: 10, window: 60 });
  const d0 = await db.domain.findFirst({ where: { id: domainId, projectId: project.id } });
  if (!d0) throw E.notFound("Domain not found");
  const d = (await checkDomain(d0.id, { manual: true }))!;
  await audit({ action: "domain.verify", teamId: team.id, actor, targetType: "domain", targetId: d.id, meta: { hostname: d.hostname, status: d.status } });
  return json({ domain: domainDTO(d) });
});
