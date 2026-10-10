import { z } from "zod";
import { route, json, query } from "@/lib/http";
import { audit } from "@/lib/audit";
import { baseKeys, projectUrl } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { customDomainOf } from "@/lib/base-ui/dto";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/base/projects/:ref/keys            → { url, anonKey }                       (VIEWER — the anon key is public by design)
 * GET /api/v1/base/projects/:ref/keys?reveal=service_role → + serviceRoleKey               (ADMIN, audited)
 */
export const GET = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const q = query(req, z.object({ reveal: z.enum(["service_role"]).optional() }));
  const { base, team, actor } = await requireBaseRole(ref, q.reveal ? "ADMIN" : "VIEWER", { scope: q.reveal ? "base:write" : "base:read" });
  const k = await baseKeys(ref);
  const url = projectUrl(ref, customDomainOf(base));
  if (!q.reveal) return json({ url, anonKey: k.anonKey }, { headers: { "cache-control": "no-store" } });
  await audit({ action: "base.secret_reveal", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, key: "service_role" } });
  return json({ url, anonKey: k.anonKey, serviceRoleKey: k.serviceRoleKey }, { headers: { "cache-control": "no-store" } });
});
