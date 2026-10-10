import { route, json, requireSession, E } from "@/lib/http";
import { db } from "@/lib/db";
import { revokeSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const s = await requireSession();
  const row = await db.session.findFirst({ where: { id, userId: s.user.id } });
  if (!row) throw E.notFound("Session not found");
  await revokeSession(id);
  await audit({ action: "user.session_revoke", userId: s.user.id, targetType: "session", targetId: id });
  return json({ ok: true });
});
