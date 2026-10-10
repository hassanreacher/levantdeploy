import { z } from "zod";
import { route, json, body, requireProjectRole } from "@/lib/http";
import { audit } from "@/lib/audit";
import { addDomain, dnsConfig, domainDTO, listDomains } from "@/lib/domains/service";
import { domainErr } from "@/lib/runtime/api";

export const dynamic = "force-dynamic";

const schema = z.object({
  hostname: z.string().min(1).max(260),
  redirectTo: z.string().max(260).nullish(),
  redirectStatus: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).nullish(),
  gitBranch: z.string().max(200).nullish(),
  /** also add the www/apex counterpart redirecting (308) to this domain */
  withWww: z.boolean().optional(),
});

/** GET /api/v1/projects/:id/domains → { items: DomainDTO[], config: { platformDomain, serverIps, cnameTarget } } */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { project } = await requireProjectRole(id, "VIEWER", { scope: "domains:read" });
  return json({ items: await listDomains(project), config: dnsConfig() });
});

/** POST /api/v1/projects/:id/domains { hostname, redirectTo?, redirectStatus?, gitBranch?, withWww? } → 201 { items } */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, schema);
  const { project, team, actor } = await requireProjectRole(id, "ADMIN", { scope: "domains:write" });
  const created = await addDomain(project, input).catch(domainErr);
  for (const d of created)
    await audit({ action: "domain.add", teamId: team.id, actor, targetType: "domain", targetId: d.id, meta: { hostname: d.hostname, redirectTo: d.redirectTo } });
  return json({ items: created.map(domainDTO) }, 201);
});
