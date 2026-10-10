import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** GET /api/v1/teams/:team/env-groups → { items: [{ id, name, description, varCount, projects }] } */
export const GET = route<{ team: string }>(async (_req, { params }) => {
  const { team } = await params;
  const { team: t } = await requireTeamRole(team, "VIEWER", { scope: "env:read" });
  const groups = await db.sharedEnvGroup.findMany({
    where: { teamId: t.id },
    orderBy: { name: "asc" },
    include: { _count: { select: { vars: true } }, projects: { include: { project: { select: { id: true, name: true, slug: true } } } } },
  });
  return json({
    items: groups.map((g) => ({ id: g.id, name: g.name, description: g.description, varCount: g._count.vars, projects: g.projects.map((p) => p.project), updatedAt: g.updatedAt })),
  });
});

const schema = z.object({ name: z.string().trim().min(1).max(60).regex(/^[\w .-]+$/, "Letters, digits, spaces, . _ -"), description: z.string().max(300).nullish() });

/** POST /api/v1/teams/:team/env-groups { name, description? } (ADMIN) → 201 { group } */
export const POST = route<{ team: string }>(async (req, { params }) => {
  const { team } = await params;
  const input = await body(req, schema);
  const { team: t, actor } = await requireTeamRole(team, "ADMIN", { scope: "env:write" });
  const exists = await db.sharedEnvGroup.findUnique({ where: { teamId_name: { teamId: t.id, name: input.name } } });
  if (exists) throw E.validation({ name: "A group with this name already exists" });
  const g = await db.sharedEnvGroup.create({ data: { teamId: t.id, name: input.name, description: input.description ?? null } });
  await audit({ action: "env_group.create", teamId: t.id, actor, targetType: "env_group", targetId: g.id, meta: { name: g.name } });
  return json({ group: g }, 201);
});
