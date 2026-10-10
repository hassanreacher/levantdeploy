import { route, json, requireSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const s = await requireSession();
  const row = await db.apiToken.findFirst({ where: { id, userId: s.user.id, revokedAt: null } });
  if (!row) throw E.notFound("Token not found");
  await db.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit({ action: "token.revoke", teamId: row.teamId, userId: s.user.id, targetType: "api_token", targetId: id, meta: { name: row.name } });
  return json({ ok: true });
});
