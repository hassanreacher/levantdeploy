import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { listEnv, viewEnv } from "@/lib/dashboard/env-api";

export const dynamic = "force-dynamic";

async function load(team: string, groupId: string, min: "VIEWER" | "ADMIN", scope: string) {
  const access = await requireTeamRole(team, min, { scope });
  const group = await db.sharedEnvGroup.findFirst({ where: { id: groupId, teamId: access.team.id } });
  if (!group) throw E.notFound("Shared env group not found");
  return { ...access, group };
}

/** GET /api/v1/teams/:team/env-groups/:groupId → { group, items, projects } */
export const GET = route<{ team: string; groupId: string }>(async (_req, { params }) => {
  const { team, groupId } = await params;
  const { group, role } = await load(team, groupId, "VIEWER", "env:read");
  const [rows, links] = await Promise.all([
    listEnv({ groupId: group.id }),
    db.projectSharedEnvGroup.findMany({ where: { groupId: group.id }, include: { project: { select: { id: true, name: true, slug: true } } } }),
  ]);
  return json({ group, items: rows.map((r) => viewEnv(r, role)), projects: links.map((l) => l.project) });
});

/** PATCH { name?, description? } (ADMIN) */
export const PATCH = route<{ team: string; groupId: string }>(async (req, { params }) => {
  const { team, groupId } = await params;
  const input = await body(req, z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(300).nullable() }).partial());
  const { group, team: t, actor } = await load(team, groupId, "ADMIN", "env:write");
  if (input.name && input.name !== group.name) {
    const exists = await db.sharedEnvGroup.findUnique({ where: { teamId_name: { teamId: t.id, name: input.name } } });
    if (exists) throw E.validation({ name: "A group with this name already exists" });
  }
  const g = await db.sharedEnvGroup.update({ where: { id: group.id }, data: input });
  await audit({ action: "env_group.update", teamId: t.id, actor, targetType: "env_group", targetId: g.id, meta: { name: g.name } });
  return json({ group: g });
});

/** DELETE (ADMIN) — unlinks from every project */
export const DELETE = route<{ team: string; groupId: string }>(async (_req, { params }) => {
  const { team, groupId } = await params;
  const { group, team: t, actor } = await load(team, groupId, "ADMIN", "env:write");
  await db.sharedEnvGroup.delete({ where: { id: group.id } });
  await audit({ action: "env_group.delete", teamId: t.id, actor, targetType: "env_group", targetId: group.id, meta: { name: group.name } });
  return json({ ok: true });
});
