import { z } from "zod";
import { route, json, body, requireProjectRole } from "@/lib/http";
import { audit } from "@/lib/audit";
import { domainDTO, removeDomain, updateDomain } from "@/lib/domains/service";
import { domainErr } from "@/lib/runtime/api";

const schema = z.object({
  redirectTo: z.string().max(260).nullish(),
  redirectStatus: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).nullish(),
  gitBranch: z.string().max(200).nullish(),
  isPrimary: z.literal(true).optional(),
  subdomain: z.string().max(63).optional(),
});

/** PATCH /api/v1/projects/:id/domains/:domainId { redirectTo?, redirectStatus?, gitBranch?, isPrimary?, subdomain? } */
export const PATCH = route<{ id: string; domainId: string }>(async (req, { params }) => {
  const { id, domainId } = await params;
  const input = await body(req, schema);
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "domains:write" });
  const d = await updateDomain(project, domainId, input).catch(domainErr);
  await audit({ action: "domain.update", teamId: team.id, actor, targetType: "domain", targetId: d.id, meta: { hostname: d.hostname, ...input } });
  return json({ domain: domainDTO(d) });
});

/** DELETE /api/v1/projects/:id/domains/:domainId */
export const DELETE = route<{ id: string; domainId: string }>(async (_req, { params }) => {
  const { id, domainId } = await params;
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "domains:write" });
  const d = await removeDomain(project, domainId).catch(domainErr);
  await audit({ action: "domain.remove", teamId: team.id, actor, targetType: "domain", targetId: d.id, meta: { hostname: d.hostname } });
  return json({ ok: true });
});
