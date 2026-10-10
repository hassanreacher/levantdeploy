import type { Project, Team, TeamRole } from "@prisma/client";
import { db } from "@/lib/db";
import { hasRole } from "@/lib/auth/roles";
import { tokenHasScope } from "@/lib/auth/tokens";

/**
 * Permission checks for agent tools. Same rules as `requireProjectRole()` in src/lib/http.ts
 * (membership role VIEWER < MEMBER < ADMIN < OWNER, token scopes, team-restricted tokens, 404 for
 * non-members), but worker-safe and returning ToolError instead of HTTP errors.
 */
export type AiActor = {
  userId: string;
  /** present when the conversation was driven by an API token */
  token: { id: string; teamId: string | null; scopes: string[] } | null;
};

export class ToolError extends Error {
  constructor(
    public code: "FORBIDDEN" | "NOT_FOUND" | "INVALID" | "UNAVAILABLE" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

/** Pure check (unit-tested): may an actor with `role` (+ optional token) do something that needs `min`/`scope`? */
export function checkAccess(opts: {
  role: TeamRole | null;
  min: TeamRole;
  scope?: string;
  token?: AiActor["token"];
  teamId: string;
}): { ok: true } | { ok: false; error: ToolError } {
  if (!opts.role) return { ok: false, error: new ToolError("NOT_FOUND", "Project not found") };
  if (opts.token?.teamId && opts.token.teamId !== opts.teamId) return { ok: false, error: new ToolError("NOT_FOUND", "Project not found") };
  if (opts.token && opts.scope && !tokenHasScope(opts.token.scopes, opts.scope))
    return { ok: false, error: new ToolError("FORBIDDEN", `The API token is missing the "${opts.scope}" scope`) };
  if (!hasRole(opts.role, opts.min)) return { ok: false, error: new ToolError("FORBIDDEN", `This requires the ${opts.min.toLowerCase()} role (you are ${opts.role.toLowerCase()})`) };
  return { ok: true };
}

export async function teamRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const m = await db.membership.findUnique({ where: { teamId_userId: { teamId, userId } }, select: { role: true } });
  return m?.role ?? null;
}

export type AiProjectAccess = { project: Project; team: Team; role: TeamRole };

/**
 * Resolves a project by id or slug **inside the conversation's team** and checks access.
 * Throws ToolError (NOT_FOUND for other teams / non-members — no existence leak).
 */
export async function aiProjectAccess(actor: AiActor, teamId: string, ref: string, min: TeamRole, scope?: string): Promise<AiProjectAccess> {
  const project = await db.project.findFirst({ where: { teamId, OR: [{ id: ref }, { slug: ref }] }, include: { team: true } });
  if (!project) throw new ToolError("NOT_FOUND", `Project "${ref}" not found in this team`);
  const role = await teamRole(teamId, actor.userId);
  const res = checkAccess({ role, min, scope, token: actor.token, teamId });
  if (!res.ok) throw res.error;
  const { team, ...p } = project;
  return { project: p as Project, team, role: role! };
}

export async function aiTeamAccess(actor: AiActor, teamId: string, min: TeamRole, scope?: string): Promise<{ team: Team; role: TeamRole }> {
  const team = await db.team.findUnique({ where: { id: teamId } });
  if (!team) throw new ToolError("NOT_FOUND", "Team not found");
  const role = await teamRole(teamId, actor.userId);
  const res = checkAccess({ role, min, scope, token: actor.token, teamId });
  if (!res.ok) throw res.error;
  return { team, role: role! };
}
