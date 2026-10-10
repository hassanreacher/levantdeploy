import { z } from "zod";
import { json, body, query, E } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hasRole } from "@/lib/auth/roles";
import { builderRoute, requireBuilder } from "@/lib/builder/access";
import { builderProjectDTO, deleteBuilderProject, DTO_INCLUDE } from "@/lib/builder/projects";

export const dynamic = "force-dynamic";

/** GET /api/v1/builder/projects/:id → { project } (VIEWER) */
export const GET = builderRoute<{ id: string }>(async (_req, { params }) => {
  const { id } = await params;
  await requireBuilder(id, "VIEWER");
  const row = await db.builderProject.findUniqueOrThrow({ where: { id }, include: DTO_INCLUDE });
  return json({ project: builderProjectDTO(row) });
});

const theme = z.object({ colors: z.record(z.string().max(100)).optional(), font: z.string().max(100).optional(), radius: z.string().max(20).optional(), mode: z.enum(["light", "dark", "system"]).optional() }).partial();
const patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  settings: z
    .object({
      knowledge: z.string().max(20_000).optional(),
      instructions: z.string().max(10_000).optional(),
      theme: theme.optional(),
      quality: z.enum(["fast", "balanced", "best"]).optional(),
      visibility: z.enum(["public", "private"]).optional(),
      model: z.record(z.unknown()).optional(),
    })
    .partial()
    .optional(),
});

/** PATCH /api/v1/builder/projects/:id { name?, description?, settings? (merged) } → { project } (MEMBER) */
export const PATCH = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const input = await body(req, patch);
  const { builder, actor, team } = await requireBuilder(id, "MEMBER");
  const settings = input.settings ? { ...((builder.settings as Record<string, unknown>) ?? {}), ...input.settings } : undefined;
  await db.builderProject.update({
    where: { id },
    data: { ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(settings ? { settings: settings as object } : {}) },
  });
  await audit({ action: "builder.update", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { fields: Object.keys(input) } });
  const row = await db.builderProject.findUniqueOrThrow({ where: { id }, include: DTO_INCLUDE });
  return json({ project: builderProjectDTO(row) });
});

/**
 * DELETE /api/v1/builder/projects/:id?confirm=<name> → { ok } — ADMIN, or the MEMBER who created it.
 * Removes the preview container and the workspace (history). The published Deploy project and the backend are kept.
 */
export const DELETE = builderRoute<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const q = query(req, z.object({ confirm: z.string().max(200).optional() }));
  const { builder, actor, team, role } = await requireBuilder(id, "MEMBER");
  if (!hasRole(role, "ADMIN") && builder.createdById !== actor.user.id) throw E.forbidden("Only admins or the app's creator can delete it");
  if (q.confirm !== undefined && q.confirm !== builder.name && q.confirm !== builder.id) throw E.bad("Type the app name to confirm");
  await deleteBuilderProject(id);
  await audit({ action: "builder.delete", teamId: team.id, actor, targetType: "builder_project", targetId: id, meta: { name: builder.name } });
  return json({ ok: true });
});
