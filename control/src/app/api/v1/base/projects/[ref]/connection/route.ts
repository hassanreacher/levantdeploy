import { z } from "zod";
import { route, json, query } from "@/lib/http";
import { audit } from "@/lib/audit";
import { baseLimits, connectionStrings } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { PUBLIC_PORT_SUPPORTED, maskConnString, type ConnectionInfoDTO } from "@/lib/base-ui/shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/base/projects/:ref/connection[?reveal=1] — connection strings.
 * MEMBER sees them with the password masked; `reveal=1` (ADMIN, audited) returns the password.
 */
export const GET = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const q = query(req, z.object({ reveal: z.enum(["1", "true"]).optional() }));
  const { base, team, actor } = await requireBaseRole(ref, q.reveal ? "ADMIN" : "MEMBER", { scope: q.reveal ? "base:write" : "base:read" });
  const [c, limits] = await Promise.all([connectionStrings(ref), baseLimits(team.id)]);
  const m = (s: string | null) => (s && !q.reveal ? maskConnString(s) : s);
  if (q.reveal) await audit({ action: "base.secret_reveal", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, key: "db_password" } });
  const out: ConnectionInfoDTO & { password?: string } = {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.pooler ? c.poolerUser : c.user,
    direct: m(c.direct)!,
    pooler: m(c.pooler),
    poolerSession: m(c.poolerSession),
    sslRequired: c.sslRequired,
    publicHost: c.publicHost,
    publicUrl: m(c.public),
    publicPort: c.publicPort,
    publicAllowed: limits.publicPort,
        publicSupported: PUBLIC_PORT_SUPPORTED,
    ...(q.reveal ? { password: c.password } : {}),
  };
  return json(out, { headers: { "cache-control": "no-store" } });
});
