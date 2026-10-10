import { route, json, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const DELETE = route<{ team: string; id: string }>(async (_req, { params }) => {
  const { team: t, id } = await params;
  const { team, actor } = await requireTeamRole(t, "ADMIN");
  const inv = await db.invite.findFirst({ where: { id, teamId: team.id } });
  if (!inv) throw E.notFound("Invite not found");
  await db.invite.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit({ action: "invite.revoke", teamId: team.id, actor, targetType: "invite", targetId: id });
  return json({ ok: true });
});
