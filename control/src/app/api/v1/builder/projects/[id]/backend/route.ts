import { z } from "zod";
import { json, body } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { attachBackend, detachBackend } from "@/lib/builder/backend";
import { builderProjectDTO, DTO_INCLUDE } from "@/lib/builder/projects";

export const dynamic = "force-dynamic";

async function backendInfo(ref: string | null) {
  if (!ref) return null;
  const b = await db.baseProject.findUnique({ where: { ref }, select: { ref: true, name: true, status: true, statusMessage: true, projectId: true } });
  return b;
}

/** GET …/backend → { backend: { ref, name, status, … } | null } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { builder } = await requireBuilder(id, "VIEWER");
  return json({ backend: await backendInfo(builder.baseRef) });
});

/**
 * POST …/backend { ref? , create? } → { project, backend, envKeys } — attach an existing LevantBase project of the team
 * or create one; writes .env.local into the preview (not committed) and restarts it. MEMBER (creating = plan limits).
 */
export const POST = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, z.object({ ref: z.string().max(40).optional(), create: z.boolean().default(false) }));
  const { actor, team } = await requireBuilder(id, "MEMBER");
  const r = await attachBackend(id, { ref: input.ref ?? null, create: input.create, userId: actor.user.id });
  await audit({ action: "builder.backend_attach", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { ref: r.ref, created: r.created } });
  const row = await db.builderProject.findUniqueOrThrow({ where: { id }, include: DTO_INCLUDE });
  return json({ project: builderProjectDTO(row), backend: { ...(await backendInfo(r.ref)), url: r.url, anonKey: r.anonKey, created: r.created }, envKeys: r.envKeys });
});

/** DELETE …/backend — detach (the backend itself is kept) (MEMBER) */
export const DELETE = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  const { actor, team, builder } = await requireBuilder(id, "MEMBER");
  await detachBackend(id);
  await audit({ action: "builder.backend_detach", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { ref: builder.baseRef } });
  return json({ ok: true });
});
