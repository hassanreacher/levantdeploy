import { z } from "zod";
import { route, json, body, requireProjectRole, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hasRole } from "@/lib/auth/roles";
import { requireBaseRole } from "@/lib/base-ui/access";
import { connectBaseEnv } from "@/lib/base-ui/connect";

const schema = z.object({
  projectId: z.string().min(1).max(64),
  /** make it the project's backend (Backend tab). A project has at most one; a backend at most one owner. */
  attach: z.boolean().default(false),
  /** write env vars */
  connectEnv: z.boolean().default(true),
  targets: z.array(z.enum(["PRODUCTION", "PREVIEW", "DEVELOPMENT"])).min(1).default(["PRODUCTION", "PREVIEW", "DEVELOPMENT"]),
  includeServiceRole: z.boolean().default(false),
  includeDatabaseUrl: z.boolean().default(false),
  databaseUrlKind: z.enum(["pooler", "direct"]).default("pooler"),
});

/**
 * POST /api/v1/base/projects/:ref/connect — connect a Base project to a Deploy project (same team):
 * writes NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_URL / SUPABASE_ANON_KEY
 * (+ SUPABASE_SERVICE_ROLE_KEY secret, ADMIN only) (+ DATABASE_URL internal) and optionally attaches it.
 * MEMBER (env:write rules). Response says a redeploy is needed.
 */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, schema);
  const b = await requireBaseRole(ref, "MEMBER");
  const p = await requireProjectRole(input.projectId, "MEMBER", { actor: b.actor });
  if (p.team.id !== b.team.id) throw E.bad("The Base project and the Deploy project must belong to the same team");
  if ((input.includeServiceRole || input.includeDatabaseUrl) && !hasRole(b.role, "ADMIN")) throw E.forbidden("Only admins can expose the service_role key or the database URL");
  if (input.attach) {
    const other = await db.baseProject.findUnique({ where: { projectId: p.project.id }, select: { id: true, name: true } });
    if (other && other.id !== b.base.id) throw E.conflict(`${p.project.name} already has a backend (${other.name}). Detach it first.`);
    if (b.base.projectId && b.base.projectId !== p.project.id) throw E.conflict(`This backend is attached to ${b.base.project?.name ?? "another project"}. Detach it first.`);
    await db.baseProject.update({ where: { id: b.base.id }, data: { projectId: p.project.id } });
    await audit({ action: "base.attach", teamId: b.team.id, actor: b.actor, targetType: "base_project", targetId: b.base.id, meta: { ref, project: p.project.slug } });
  }
  const env = input.connectEnv
    ? await connectBaseEnv({ ref, projectId: p.project.id, teamId: b.team.id, actor: b.actor, targets: input.targets, options: { includeServiceRole: input.includeServiceRole, includeDatabaseUrl: input.includeDatabaseUrl, databaseUrlKind: input.databaseUrlKind } })
    : null;
  return json({ ok: true, attached: input.attach, keys: env?.keys ?? [], redeployRequired: !!env });
});

/** DELETE /api/v1/base/projects/:ref/connect — detach from its Deploy project (env vars are kept). MEMBER. */
export const DELETE = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const b = await requireBaseRole(ref, "MEMBER");
  if (!b.base.projectId) return json({ ok: true });
  await requireProjectRole(b.base.projectId, "MEMBER", { actor: b.actor });
  await db.baseProject.update({ where: { id: b.base.id }, data: { projectId: null } });
  await audit({ action: "base.detach", teamId: b.team.id, actor: b.actor, targetType: "base_project", targetId: b.base.id, meta: { ref, project: b.base.project?.slug ?? null } });
  return json({ ok: true });
});
