import { z } from "zod";
import { route, json, body, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertCanCreateFunction, deployFunction, projectUrl } from "@/lib/base-ui/adapters";
import { mapBaseError, requireBaseRole } from "@/lib/base-ui/access";
import { customDomainOf, functionDTO } from "@/lib/base-ui/dto";
import { FUNCTION_SLUG_RE, FUNCTION_TEMPLATES } from "@/lib/base-ui/shared";

export const dynamic = "force-dynamic";

/** GET /api/v1/base/projects/:ref/functions — VIEWER. */
export const GET = route<{ ref: string }>(async (_req, { params }) => {
  const { ref } = await params;
  const { base } = await requireBaseRole(ref, "VIEWER");
  const rows = await db.baseFunction.findMany({ where: { baseProjectId: base.id }, orderBy: { slug: "asc" } });
  const api = projectUrl(ref, customDomainOf(base));
  return json({ items: rows.map((f) => functionDTO(ref, f, api)) });
});

const createSchema = z.object({
  slug: z.string().trim().regex(FUNCTION_SLUG_RE, "Lowercase letters, digits and dashes; start with a letter"),
  name: z.string().trim().max(100).optional(),
  template: z.enum(FUNCTION_TEMPLATES.map((t) => t.id) as [string, ...string[]]).optional(),
  code: z.string().max(512 * 1024).optional(),
  verifyJwt: z.boolean().default(true),
  /** extra files next to index.ts (relative paths, e.g. "_shared/cors.ts") — CLI `levant base functions deploy` (compat) */
  files: z
    .record(z.string().min(1).max(200).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/, "Relative path inside the function folder"), z.string().max(512 * 1024))
    .refine((f) => Object.keys(f).length <= 100, "At most 100 files")
    .optional(),
});

/** POST /api/v1/base/projects/:ref/functions { slug, template? | code?, verifyJwt } — MEMBER: create + deploy. */
export const POST = route<{ ref: string }>(async (req, { params }) => {
  const { ref } = await params;
  const input = await body(req, createSchema);
  const { base, team, actor } = await requireBaseRole(ref, "MEMBER");
  await throttle(`base:fn:${actor.user.id}`, { limit: 30, window: 60 });
  if (base.status !== "ACTIVE") throw E.conflict("The project must be running to deploy functions");
  if (await db.baseFunction.findUnique({ where: { baseProjectId_slug: { baseProjectId: base.id, slug: input.slug } }, select: { id: true } })) throw E.conflict(`A function named "${input.slug}" already exists`);
  await assertCanCreateFunction(team.id, base.id).catch(mapBaseError);
  const code = input.code ?? FUNCTION_TEMPLATES.find((t) => t.id === (input.template ?? "hello-world"))!.code;
  const fn = await deployFunction(ref, { slug: input.slug, name: input.name || input.slug, code, verifyJwt: input.verifyJwt, files: input.files }, actor.user.id);
  await audit({ action: "base.function.create", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, slug: input.slug, template: input.template ?? null } });
  return json({ function: functionDTO(ref, fn, projectUrl(ref, customDomainOf(base))) }, 201);
});
