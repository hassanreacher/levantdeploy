import { z } from "zod";
import { route, json, body, query, throttle, requireTeamRole, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createBaseProject } from "@/lib/base-ui/adapters";
import { mapBaseError } from "@/lib/base-ui/access";
import { baseInclude, listTeamBases, toBaseDTO } from "@/lib/base-ui/dto";
import { connectBaseEnv } from "@/lib/base-ui/connect";
import { BASE_NAME_RE, DB_PASSWORD_RE, passwordStrength } from "@/lib/base-ui/shared";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects?team=<slug|id> — Base projects of a team (VIEWER, base:read). */
export const GET = route(async (req) => {
  const q = query(req, z.object({ team: z.string().min(1).max(64) }));
  const { team } = await requireTeamRole(q.team, "VIEWER", { scope: "base:read" });
  return json({ items: await listTeamBases(team.id) });
});

const createSchema = z.object({
  team: z.string().min(1).max(64),
  name: z.string().trim().min(1, "Name is required").max(63).regex(BASE_NAME_RE, "Use letters, digits, spaces, dots, dashes or underscores"),
  dbPassword: z
    .string()
    .regex(DB_PASSWORD_RE, "Use 16–128 letters and digits")
    .refine((p) => passwordStrength(p).score >= 3, "This password is too weak")
    .optional(),
  /** attach to a Deploy project (its "Backend" tab) + write env vars */
  projectId: z.string().min(1).max(64).optional(),
  connectEnv: z.boolean().default(true),
  includeServiceRole: z.boolean().default(false),
});

/**
 * POST /api/v1/base/projects { team, name, dbPassword?, projectId? } — MEMBER. Plan-checked (assertCanCreateProject).
 * Returns 201 { project } (status PROVISIONING; follow /projects/:ref/events).
 */
export const POST = route(async (req) => {
  const input = await body(req, createSchema);
  const { team, actor } = await requireTeamRole(input.team, "MEMBER", { scope: "base:write" });
  await throttle(`base:create:${actor.user.id}`, { limit: 10, window: 600 });
  let project: { id: string; slug: string } | null = null;
  if (input.projectId) {
    const p = await requireProjectRole(input.projectId, "MEMBER", { actor });
    if (p.team.id !== team.id) throw E.bad("The project belongs to another team");
    if (await db.baseProject.findUnique({ where: { projectId: p.project.id }, select: { id: true } })) throw E.conflict(`${p.project.name} already has a backend`);
    if (input.includeServiceRole && p.role !== "ADMIN" && p.role !== "OWNER") throw E.forbidden("Only admins can expose the service_role key as an env var");
    project = { id: p.project.id, slug: p.project.slug };
  }
  const row = await (async () => {
    try {
      // plan cap + email verification happen inside the runtime's createBaseProject (assertCanCreateProject)
      return await createBaseProject({ teamId: team.id, name: input.name, dbPassword: input.dbPassword, createdById: actor.user.id, projectId: project?.id ?? null });
    } catch (e) {
      return mapBaseError(e);
    }
  })();
  await audit({ action: "base.create", teamId: team.id, actor, targetType: "base_project", targetId: row.id, meta: { ref: row.ref, name: row.name, project: project?.slug ?? null } });
  if (project && input.connectEnv) {
    await connectBaseEnv({ ref: row.ref, projectId: project.id, teamId: team.id, actor, targets: ["PRODUCTION", "PREVIEW", "DEVELOPMENT"], options: { includeServiceRole: input.includeServiceRole, includeDatabaseUrl: false, databaseUrlKind: "pooler" } }).catch((e) =>
      console.error("[base] connect env failed", e),
    );
  }
  const full = await db.baseProject.findUniqueOrThrow({ where: { id: row.id }, include: baseInclude });
  return json({ project: toBaseDTO(full) }, 201);
});
