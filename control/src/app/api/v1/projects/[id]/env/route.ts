import { z } from "zod";
import { route, json, body, query, requireProjectRole, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hasRole } from "@/lib/auth/roles";
import { createEnv, envChangedSinceDeploy, envCreateSchema, listEnv, viewEnv } from "@/lib/dashboard/env-api";
import { resolveEnv, toDotenv } from "@/lib/dashboard/env-vars";

export const dynamic = "force-dynamic";

const q = z.object({
  /** "dotenv" → resolved .env text for `target` (CLI `env pull`): secrets need ADMIN */
  format: z.enum(["json", "dotenv"]).default("json"),
  target: z.enum(["PRODUCTION", "PREVIEW", "DEVELOPMENT"]).default("DEVELOPMENT"),
  branch: z.string().max(255).optional(),
  /** 1 → include values of secrets too (ADMIN) */
  decrypt: z.enum(["0", "1"]).default("0"),
});

/**
 * GET /api/v1/projects/:id/env → { items, groups, pending }
 *   values of non-secret vars are returned to MEMBER+; secrets only with decrypt=1 (ADMIN+) or via /env/:envId/reveal.
 * GET /api/v1/projects/:id/env?format=dotenv&target=DEVELOPMENT → text/plain .env (MEMBER; secrets omitted unless ADMIN)
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const opts = query(req, q);
  const { project, role, team, actor } = await requireProjectRole(id, "VIEWER", { scope: "env:read" });
  if (opts.format === "dotenv") {
    if (!hasRole(role, "MEMBER")) throw E.forbidden("Viewers can't read environment variable values");
    const env = await resolveEnv(project.id, opts.target, opts.branch);
    if (!hasRole(role, "ADMIN")) {
      const secrets = await db.envVar.findMany({ where: { OR: [{ projectId: project.id }, { group: { projects: { some: { projectId: project.id } } } }], isSecret: true }, select: { key: true } });
      for (const s of secrets) delete env[s.key];
    }
    await audit({ action: "env.pull", teamId: team.id, actor, targetType: "project_env", targetId: project.id, meta: { target: opts.target } });
    return new Response(toDotenv(Object.entries(env).map(([key, value]) => ({ key, value }))), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const decryptAll = opts.decrypt === "1";
  const rows = await listEnv({ projectId: project.id });
  const links = await db.projectSharedEnvGroup.findMany({ where: { projectId: project.id }, include: { group: { include: { _count: { select: { vars: true } } } } } });
  return json({
    items: rows.map((r) => viewEnv(r, role, decryptAll)),
    groups: links.map((l) => ({ id: l.group.id, name: l.group.name, description: l.group.description, varCount: l.group._count.vars, linkedAt: l.createdAt.toISOString() })),
    pending: await envChangedSinceDeploy(project.id),
  });
});

/**
 * POST /api/v1/projects/:id/env  (MEMBER)
 *   { items: [{ key, value, targets?, isSecret?, branch?, comment? }] }
 *   or { dotenv: "A=1\nB=2", targets?, isSecret?, branch? }      (bulk paste)
 *   overwrite: true replaces existing values instead of 409.
 * → 201 { created, updated, keys }
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, envCreateSchema);
  const { project, team, actor } = await requireProjectRole(id, "MEMBER", { scope: "env:write" });
  await throttle(`env:${actor.user.id}`);
  const res = await createEnv({ projectId: project.id }, input, actor.user.id);
  await audit({ action: res.updated && !res.created ? "env.update" : "env.create", teamId: team.id, actor, targetType: "project", targetId: project.id, meta: { keys: res.keys.slice(0, 50), created: res.created, updated: res.updated } });
  return json(res, 201);
});
