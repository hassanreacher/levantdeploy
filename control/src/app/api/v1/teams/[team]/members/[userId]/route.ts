import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

type P = { team: string; userId: string };
const schema = z.object({ role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]) });

async function ownerCount(teamId: string) {
  return db.membership.count({ where: { teamId, role: "OWNER" } });
}

export const PATCH = route<P>(async (req, { params }) => {
  const { team: t, userId } = await params;
  const { role } = await body(req, schema);
  const { team, role: myRole, actor } = await requireTeamRole(t, "ADMIN");
  const m = await db.membership.findUnique({ where: { teamId_userId: { teamId: team.id, userId } } });
  if (!m) throw E.notFound("Member not found");
  if ((role === "OWNER" || m.role === "OWNER") && myRole !== "OWNER") throw E.forbidden("Only owners can change owner roles");
  if (m.role === "OWNER" && role !== "OWNER" && (await ownerCount(team.id)) <= 1) throw E.bad("A team needs at least one owner");
  const updated = await db.membership.update({ where: { id: m.id }, data: { role } });
  await audit({ action: "member.role_change", teamId: team.id, actor, targetType: "user", targetId: userId, meta: { from: m.role, to: role } });
  return json({ member: updated });
});

/** Remove a member (ADMIN+), or leave the team (any member removing themselves). */
export const DELETE = route<P>(async (_req, { params }) => {
  const { team: t, userId } = await params;
  const self = await requireTeamRole(t, "VIEWER");
  const leaving = self.user.id === userId;
  if (!leaving && self.role !== "OWNER" && self.role !== "ADMIN") throw E.forbidden();
  const m = await db.membership.findUnique({ where: { teamId_userId: { teamId: self.team.id, userId } } });
  if (!m) throw E.notFound("Member not found");
  if (m.role === "OWNER" && !leaving && self.role !== "OWNER") throw E.forbidden("Only owners can remove owners");
  if (self.team.isPersonal && leaving && m.role === "OWNER") throw E.bad("You can't leave your personal team");
  if (m.role === "OWNER" && (await ownerCount(self.team.id)) <= 1) throw E.bad("A team needs at least one owner");
  await db.membership.delete({ where: { id: m.id } });
  await audit({ action: leaving ? "member.leave" : "member.remove", teamId: self.team.id, actor: self.actor, targetType: "user", targetId: userId });
  return json({ ok: true });
});
