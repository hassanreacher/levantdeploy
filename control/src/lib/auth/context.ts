import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Project, Team, TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { teamsForUser, type TeamSummary } from "@/lib/teams";
import { requireUser, type SessionUser } from "./session";

/**
 * Page/layout helpers (server components). Deduped per request with React cache().
 *   const { user, team, role, teams } = await getTeamContext(params.team);
 *   const { project } = await getProjectContext(params.team, params.project);
 * Non-members get notFound() (no existence leak); signed-out users are redirected to /login.
 */
export type TeamContext = { user: SessionUser; team: Team; role: TeamRole; teams: TeamSummary[] };
export type ProjectContext = TeamContext & { project: Project };

export const getTeamContext = cache(async (teamSlug: string): Promise<TeamContext> => {
  const user = await requireUser(`/${teamSlug}`);
  const teams = await teamsForUser(user.id);
  const t = teams.find((x) => x.slug === teamSlug);
  if (!t) notFound();
  const team = await db.team.findUnique({ where: { id: t.id } });
  if (!team) notFound();
  return { user, team, role: t.role, teams };
});

export const getProjectContext = cache(async (teamSlug: string, projectSlug: string): Promise<ProjectContext> => {
  const ctx = await getTeamContext(teamSlug);
  const project = await db.project.findUnique({ where: { teamId_slug: { teamId: ctx.team.id, slug: projectSlug } } });
  if (!project) notFound();
  return { ...ctx, project };
});
