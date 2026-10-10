import { route, json, requireTeamRole } from "@/lib/http";
import { db } from "@/lib/db";

export const GET = route<{ team: string }>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team } = await requireTeamRole(t, "VIEWER");
  const members = await db.membership.findMany({
    where: { teamId: team.id },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true, email: true, avatar: true, totpEnabled: true, lastLoginAt: true } } },
  });
  return json({ members: members.map((m) => ({ id: m.id, role: m.role, joinedAt: m.createdAt, user: m.user })) });
});
