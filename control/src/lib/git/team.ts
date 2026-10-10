import "server-only";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { TEAM_COOKIE } from "@/lib/auth/jwt";
import { requireApiTokenOrSession, requireTeamRole, E, type Actor } from "@/lib/http";
import type { TeamRole } from "@prisma/client";

/**
 * Team for endpoints that take an optional `team` (slug or id): explicit value → the token's team →
 * the `ld_team` cookie → the caller's first team.
 */
export async function resolveTeam(team: string | null | undefined, min: TeamRole = "VIEWER", opts: { scope?: string; actor?: Actor } = {}) {
  const actor = opts.actor ?? (await requireApiTokenOrSession({ scope: opts.scope }));
  let ref = team || actor.token?.teamId || null;
  if (!ref) {
    const c = (await cookies()).get(TEAM_COOKIE)?.value;
    if (c) ref = c;
  }
  if (!ref) {
    const m = await db.membership.findFirst({ where: { userId: actor.user.id }, orderBy: { createdAt: "asc" }, select: { teamId: true } });
    if (!m) throw E.notFound("Team not found");
    ref = m.teamId;
  }
  return requireTeamRole(ref, min, { actor });
}
