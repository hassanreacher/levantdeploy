import { z } from "zod";
import { route, json, body, requireTeamRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { RESERVED_TEAM_SLUGS } from "@/lib/teams";
import { audit } from "@/lib/audit";

type P = { team: string };

export const GET = route<P>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team, role } = await requireTeamRole(t, "VIEWER");
  const [members, projects] = await Promise.all([
    db.membership.count({ where: { teamId: team.id } }),
    db.project.count({ where: { teamId: team.id } }),
  ]);
  return json({ team, role, counts: { members, projects } });
});

const patch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and dashes only")
    .optional(),
  avatar: z.string().url().max(500).nullable().optional(),
});

export const PATCH = route<P>(async (req, { params }) => {
  const { team: t } = await params;
  const input = await body(req, patch);
  const { team, actor } = await requireTeamRole(t, input.slug ? "OWNER" : "ADMIN");
  if (input.slug && input.slug !== team.slug) {
    if (RESERVED_TEAM_SLUGS.has(input.slug)) throw E.validation({ slug: "This slug is reserved" });
    if (await db.team.findUnique({ where: { slug: input.slug } })) throw E.validation({ slug: "This slug is taken" });
  }
  const updated = await db.team.update({ where: { id: team.id }, data: input });
  await audit({ action: "team.update", teamId: team.id, actor, targetType: "team", targetId: team.id, meta: input });
  return json({ team: updated });
});

export const DELETE = route<P>(async (_req, { params }) => {
  const { team: t } = await params;
  const { team, actor } = await requireTeamRole(t, "OWNER");
  if (team.isPersonal) throw E.bad("Your personal team can't be deleted");
  const active = await db.project.count({ where: { teamId: team.id } });
  if (active > 0) throw E.conflict("Delete or transfer this team's projects first");
  await db.team.delete({ where: { id: team.id } });
  await audit({ action: "team.delete", actor, targetType: "team", targetId: team.id, meta: { slug: team.slug } });
  return json({ ok: true });
});
