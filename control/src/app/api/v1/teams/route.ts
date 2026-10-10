import { z } from "zod";
import { route, json, body, requireApiTokenOrSession, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { createTeam, teamsForUser, RESERVED_TEAM_SLUGS, slugify } from "@/lib/teams";
import { audit } from "@/lib/audit";

export const GET = route(async () => {
  const actor = await requireApiTokenOrSession();
  const teams = await teamsForUser(actor.user.id);
  return json({ teams: actor.token?.teamId ? teams.filter((t) => t.id === actor.token!.teamId) : teams });
});

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "At least 2 characters")
  .max(40)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and dashes only");

const schema = z.object({ name: z.string().trim().min(1, "Enter a team name").max(60), slug: slugSchema.optional() });

export const POST = route(async (req) => {
  const actor = await requireApiTokenOrSession({ scope: "projects:write" });
  if (actor.token?.teamId) throw E.forbidden("Team-scoped tokens can't create teams");
  await throttle(`team-create:${actor.user.id}`, { limit: 10, window: 3600 });
  const input = await body(req, schema);
  const slug = input.slug ?? undefined;
  if (slug) {
    if (RESERVED_TEAM_SLUGS.has(slug)) throw E.validation({ slug: "This slug is reserved" });
    if (await db.team.findUnique({ where: { slug } })) throw E.validation({ slug: "This slug is taken" });
  }
  const team = await createTeam({ name: input.name, slug: slug ?? undefined, ownerId: actor.user.id });
  await audit({ action: "team.create", teamId: team.id, actor, targetType: "team", targetId: team.id, meta: { name: team.name, slug: team.slug } });
  return json({ team: { ...team, role: "OWNER" }, suggestedSlug: slugify(input.name) }, 201);
});
