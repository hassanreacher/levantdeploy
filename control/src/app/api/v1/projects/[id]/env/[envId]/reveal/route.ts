import { route, json, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hasRole } from "@/lib/auth/roles";
import { decryptString } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/** GET /api/v1/projects/:id/env/:envId/reveal → { value }   (secrets: ADMIN+, audited; plain vars: MEMBER+) */
export const GET = route<{ id: string; envId: string }>(async (_req, { params }) => {
  const { id, envId } = await params;
  const { project, team, actor, role } = await requireProjectRole(id, "MEMBER", { scope: "env:read" });
  const row = await db.envVar.findFirst({ where: { id: envId, projectId: project.id } });
  if (!row) throw E.notFound("Environment variable not found");
  if (row.isSecret && !hasRole(role, "ADMIN")) throw E.forbidden("Only admins can reveal secret values");
  const value = decryptString(row.valueEnc);
  if (value === null) throw E.conflict("This value can't be decrypted (ENCRYPTION_KEY changed?)");
  if (row.isSecret) await audit({ action: "env.reveal", teamId: team.id, actor, targetType: "env_var", targetId: row.id, meta: { key: row.key, projectId: project.id } });
  return json({ value });
});
