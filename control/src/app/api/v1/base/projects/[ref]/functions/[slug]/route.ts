import { z } from "zod";
import { route, json, body, throttle, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { deleteFunction, deployFunction, functionSource, projectUrl } from "@/lib/base-ui/adapters";
import { requireBaseRole } from "@/lib/base-ui/access";
import { customDomainOf, functionDTO } from "@/lib/base-ui/dto";

export const dynamic = "force-dynamic";

async function load(ref: string, slug: string, min: "VIEWER" | "MEMBER") {
  const a = await requireBaseRole(ref, min);
  const fn = await db.baseFunction.findUnique({ where: { baseProjectId_slug: { baseProjectId: a.base.id, slug } } });
  if (!fn) throw E.notFound("Function not found");
  return { ...a, fn };
}

/** GET — function + source (MEMBER: source may contain business logic). */
export const GET = route<{ ref: string; slug: string }>(async (_req, { params }) => {
  const { ref, slug } = await params;
  const { base, fn } = await load(ref, slug, "MEMBER");
  return json({ function: functionDTO(ref, fn, projectUrl(ref, customDomainOf(base))), code: (await functionSource(ref, slug).catch(() => null)) ?? "" });
});

const patchSchema = z.object({
  code: z.string().max(512 * 1024).optional(),
  verifyJwt: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  /** extra files next to index.ts (relative paths, e.g. "_shared/cors.ts") — CLI `levant base functions deploy` (compat) */
  files: z
    .record(z.string().min(1).max(200).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/, "Relative path inside the function folder"), z.string().max(512 * 1024))
    .refine((f) => Object.keys(f).length <= 100, "At most 100 files")
    .optional(),
});

/** PATCH { code?, verifyJwt?, name? } — MEMBER: redeploys the function (new version). */
export const PATCH = route<{ ref: string; slug: string }>(async (req, { params }) => {
  const { ref, slug } = await params;
  const input = await body(req, patchSchema);
  const { base, team, actor, fn } = await load(ref, slug, "MEMBER");
  await throttle(`base:fn:${actor.user.id}`, { limit: 30, window: 60 });
  if (base.status !== "ACTIVE") throw E.conflict("The project must be running to deploy functions");
  const code = input.code ?? (await functionSource(ref, slug)) ?? "";
  const next = await deployFunction(ref, { slug, name: input.name ?? fn.name, code, verifyJwt: input.verifyJwt ?? fn.verifyJwt, files: input.files }, actor.user.id);
  await audit({ action: "base.function.deploy", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, slug, version: next.version, verifyJwt: next.verifyJwt } });
  return json({ function: functionDTO(ref, next, projectUrl(ref, customDomainOf(base))) });
});

/** DELETE — MEMBER. */
export const DELETE = route<{ ref: string; slug: string }>(async (_req, { params }) => {
  const { ref, slug } = await params;
  const { base, team, actor } = await load(ref, slug, "MEMBER");
  await deleteFunction(ref, slug);
  await audit({ action: "base.function.delete", teamId: team.id, actor, targetType: "base_project", targetId: base.id, meta: { ref, slug } });
  return json({ ok: true });
});
