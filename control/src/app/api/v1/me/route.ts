import { z } from "zod";
import { route, json, body, requireApiTokenOrSession, requireSession } from "@/lib/http";
import { db } from "@/lib/db";
import { teamsForUser } from "@/lib/teams";
import { refreshUserSessions } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

export const GET = route(async () => {
  const actor = await requireApiTokenOrSession();
  const teams = await teamsForUser(actor.user.id);
  return json({ user: actor.user, teams: actor.token?.teamId ? teams.filter((t) => t.id === actor.token!.teamId) : teams, via: actor.kind });
});

const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatar: z.string().url().max(500).nullable().optional(),
});

export const PATCH = route(async (req) => {
  const s = await requireSession();
  const input = await body(req, patch);
  const user = await db.user.update({ where: { id: s.user.id }, data: input, select: { id: true, email: true, name: true, avatar: true } });
  await refreshUserSessions(s.user.id);
  await audit({ action: "user.update", userId: s.user.id, meta: { fields: Object.keys(input) } });
  return json({ user });
});
