import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertCanCreateBase } from "@/lib/base-ui/adapters";
import { mapBaseError, requireBaseRole } from "@/lib/base-ui/access";

/** POST /api/v1/base/projects/:ref/transfer { team } — ADMIN in both teams. Detaches it from its Deploy project. */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, z.object({ team: z.string().min(1).max(64), confirm: z.string().max(200) }));
  const from = await requireBaseRole(ref, "ADMIN");
  if (input.confirm.trim() !== from.base.name && input.confirm.trim() !== from.base.ref) throw E.validation({ confirm: `Type "${from.base.name}" to confirm` });
  const to = await requireTeamRole(input.team, "ADMIN", { actor: from.actor });
  if (to.team.id === from.team.id) throw E.bad("The project already belongs to this team");
  await assertCanCreateBase(to.team.id).catch(mapBaseError);
  await db.baseProject.update({ where: { id: from.base.id }, data: { teamId: to.team.id, projectId: null } });
  const meta = { ref, name: from.base.name, from: from.team.slug, to: to.team.slug };
  await audit({ action: "base.transfer", teamId: from.team.id, actor: from.actor, targetType: "base_project", targetId: from.base.id, meta });
  await audit({ action: "base.transfer", teamId: to.team.id, actor: from.actor, targetType: "base_project", targetId: from.base.id, meta });
  return json({ ok: true, team: { slug: to.team.slug } });
});
